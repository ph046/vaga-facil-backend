require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

const MP_PLAN_MENSAL = process.env.MP_PLAN_MENSAL;
const MP_PLAN_TRIMESTRAL = process.env.MP_PLAN_TRIMESTRAL;

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || "https://www.mercadopago.com.br";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !MP_ACCESS_TOKEN) {
  console.error("Erro: variáveis de ambiente obrigatórias ausentes.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

function limparEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function limparDeviceId(deviceId) {
  return String(deviceId || "").trim();
}

function criarHashCurto(texto) {
  return crypto
    .createHash("sha256")
    .update(texto)
    .digest("hex")
    .slice(0, 16);
}

function dadosDoPlano(plan) {
  if (plan === "mensal") {
    return {
      plan: "mensal",
      planId: MP_PLAN_MENSAL,
      label: "Plano Mensal",
      dias: 35
    };
  }

  if (plan === "trimestral") {
    return {
      plan: "trimestral",
      planId: MP_PLAN_TRIMESTRAL,
      label: "Plano Trimestral",
      dias: 100
    };
  }

  return null;
}

function adicionarDias(dias) {
  const data = new Date();
  data.setDate(data.getDate() + dias);
  return data.toISOString();
}

function mapearStatusMercadoPago(statusMp) {
  const status = String(statusMp || "").toLowerCase();

  if (status === "authorized" || status === "active" || status === "approved") {
    return "active";
  }

  if (status === "cancelled" || status === "canceled") {
    return "cancelled";
  }

  if (status === "paused") {
    return "paused";
  }

  if (status === "expired") {
    return "expired";
  }

  return "pending";
}

async function chamarMercadoPago(path, method = "GET", body = null) {
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Mercado Pago ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "Vaga Fácil Backend",
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString()
  });
});

/**
 * Cria o checkout de assinatura.
 *
 * Body:
 * {
 *   "email": "cliente@email.com",
 *   "deviceId": "android-id-do-cliente",
 *   "plan": "mensal" ou "trimestral"
 * }
 */
app.post("/api/create-checkout", async (req, res) => {
  try {
    const email = limparEmail(req.body.email);
    const deviceId = limparDeviceId(req.body.deviceId);
    const plan = String(req.body.plan || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        ok: false,
        error: "E-mail inválido."
      });
    }

    if (!deviceId || deviceId.length < 5) {
      return res.status(400).json({
        ok: false,
        error: "ID do aparelho inválido."
      });
    }

    const plano = dadosDoPlano(plan);

    if (!plano || !plano.planId) {
      return res.status(400).json({
        ok: false,
        error: "Plano inválido."
      });
    }

    const baseRef = `${email}:${deviceId}:${plan}:${Date.now()}`;
    const externalReference = `vf_${criarHashCurto(baseRef)}`;

    const registroPendente = {
      email,
      device_id: deviceId,
      plan: plano.plan,
      status: "pending",
      external_reference: externalReference,
      checkout_url: null,
      mp_preapproval_id: null,
      expires_at: null
    };

    const { error: upsertError } = await supabase
      .from("licenses")
      .upsert(registroPendente, {
        onConflict: "email,device_id"
      });

    if (upsertError) {
      throw upsertError;
    }

    const assinatura = await chamarMercadoPago("/preapproval", "POST", {
      preapproval_plan_id: plano.planId,
      reason: `Vaga Fácil - ${plano.label}`,
      payer_email: email,
      external_reference: externalReference,
      back_url: PUBLIC_APP_URL
    });

    const checkoutUrl =
      assinatura.init_point ||
      assinatura.sandbox_init_point ||
      assinatura.checkout_url ||
      assinatura.url ||
      null;

    const { error: updateError } = await supabase
      .from("licenses")
      .update({
        mp_preapproval_id: assinatura.id || null,
        checkout_url: checkoutUrl
      })
      .eq("external_reference", externalReference);

    if (updateError) {
      throw updateError;
    }

    return res.json({
      ok: true,
      checkout_url: checkoutUrl,
      external_reference: externalReference,
      mp_preapproval_id: assinatura.id || null
    });
  } catch (error) {
    console.error("create-checkout error:", error);

    return res.status(500).json({
      ok: false,
      error: "Erro ao criar checkout.",
      details: String(error.message || error)
    });
  }
});

/**
 * Verifica se o cliente está ativo.
 *
 * Query:
 * /api/check-license?email=cliente@email.com&deviceId=abc123
 */
app.get("/api/check-license", async (req, res) => {
  try {
    const email = limparEmail(req.query.email);
    const deviceId = limparDeviceId(req.query.deviceId);

    if (!email || !deviceId) {
      return res.status(400).json({
        ok: false,
        active: false,
        error: "E-mail e deviceId são obrigatórios."
      });
    }

    const { data, error } = await supabase
      .from("licenses")
      .select("email, device_id, plan, status, expires_at, updated_at")
      .eq("email", email)
      .eq("device_id", deviceId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return res.json({
        ok: true,
        active: false,
        status: "not_found",
        plan: "none",
        expires_at: null
      });
    }

    const agora = new Date();
    const expira = data.expires_at ? new Date(data.expires_at) : null;

    const active =
      data.status === "active" &&
      expira instanceof Date &&
      !Number.isNaN(expira.getTime()) &&
      expira > agora;

    return res.json({
      ok: true,
      active,
      status: data.status,
      plan: data.plan,
      expires_at: data.expires_at
    });
  } catch (error) {
    console.error("check-license error:", error);

    return res.status(500).json({
      ok: false,
      active: false,
      error: "Erro ao verificar licença."
    });
  }
});

/**
 * Webhook do Mercado Pago.
 * Configure no Mercado Pago:
 * https://SEU_BACKEND.onrender.com/webhook/mercadopago
 */
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const payload = req.body || {};

    const eventType =
      payload.type ||
      payload.action ||
      req.query.type ||
      req.query.topic ||
      "unknown";

    const mpId =
      payload?.data?.id ||
      payload?.resource?.id ||
      payload.id ||
      req.query.id ||
      req.query["data.id"] ||
      null;

    await supabase.from("payment_events").insert({
      event_type: String(eventType),
      mp_id: mpId ? String(mpId) : null,
      external_reference: payload.external_reference || null,
      raw_payload: payload
    });

    if (!mpId) {
      return res.json({
        ok: true,
        ignored: true,
        reason: "Sem ID do Mercado Pago no webhook."
      });
    }

    const assinatura = await chamarMercadoPago(`/preapproval/${mpId}`, "GET");

    const externalReference = assinatura.external_reference;

    if (!externalReference) {
      return res.json({
        ok: true,
        ignored: true,
        reason: "Assinatura sem external_reference."
      });
    }

    const plan =
      assinatura.preapproval_plan_id === MP_PLAN_TRIMESTRAL
        ? "trimestral"
        : "mensal";

    const status = mapearStatusMercadoPago(assinatura.status);

    let expiresAt = null;

    if (status === "active") {
      if (assinatura.next_payment_date) {
        expiresAt = new Date(assinatura.next_payment_date).toISOString();
      } else {
        expiresAt = adicionarDias(plan === "trimestral" ? 100 : 35);
      }
    }

    const { error: updateError } = await supabase
      .from("licenses")
      .update({
        plan,
        status,
        mp_preapproval_id: assinatura.id || String(mpId),
        expires_at: expiresAt
      })
      .eq("external_reference", externalReference);

    if (updateError) {
      throw updateError;
    }

    return res.json({
      ok: true,
      updated: true,
      external_reference: externalReference,
      status,
      plan,
      expires_at: expiresAt
    });
  } catch (error) {
    console.error("webhook error:", error);

    return res.status(500).json({
      ok: false,
      error: "Erro no webhook.",
      details: String(error.message || error)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Vaga Fácil backend rodando na porta ${PORT}`);
});
