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

const BACKEND_PUBLIC_URL =
  process.env.BACKEND_PUBLIC_URL || "https://vaga-facil-backend.onrender.com";

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
    .slice(0, 18);
}

function dadosDoPlano(plan) {
  if (plan === "mensal") {
    return {
      plan: "mensal",
      titulo: "Vaga Fácil - Plano Mensal",
      valor: 9.99,
      dias: 35
    };
  }

  if (plan === "trimestral") {
    return {
      plan: "trimestral",
      titulo: "Vaga Fácil - Plano Trimestral",
      valor: 26.99,
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

async function chamarMercadoPago(path, method = "GET", body = null) {
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": crypto.randomUUID()
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Mercado Pago ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function ativarLicencaPorReferencia(externalReference, paymentId = null) {
  const { data: licenca, error: buscaErro } = await supabase
    .from("licenses")
    .select("*")
    .eq("external_reference", externalReference)
    .maybeSingle();

  if (buscaErro) {
    throw buscaErro;
  }

  if (!licenca) {
    return {
      updated: false,
      reason: "Licença não encontrada."
    };
  }

  const plano = dadosDoPlano(licenca.plan || "mensal");
  const expiresAt = adicionarDias(plano ? plano.dias : 35);

  const { error: updateError } = await supabase
    .from("licenses")
    .update({
      status: "active",
      expires_at: expiresAt,
      mp_preapproval_id: paymentId ? String(paymentId) : licenca.mp_preapproval_id
    })
    .eq("external_reference", externalReference);

  if (updateError) {
    throw updateError;
  }

  return {
    updated: true,
    status: "active",
    plan: licenca.plan,
    expires_at: expiresAt
  };
}

async function buscarPagamentoAprovadoPorReferencia(externalReference) {
  const encodedRef = encodeURIComponent(externalReference);

  const result = await chamarMercadoPago(
    `/v1/payments/search?external_reference=${encodedRef}`,
    "GET"
  );

  const pagamentos = Array.isArray(result.results) ? result.results : [];

  return pagamentos.find((pagamento) => {
    return String(pagamento.status || "").toLowerCase() === "approved";
  });
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

    if (!plano) {
      return res.status(400).json({
        ok: false,
        error: "Plano inválido."
      });
    }

    const baseRef = `${email}:${deviceId}:${plan}:${Date.now()}`;
    const externalReference = `vf_${criarHashCurto(baseRef)}`;

    const { error: upsertError } = await supabase
      .from("licenses")
      .upsert(
        {
          email,
          device_id: deviceId,
          plan: plano.plan,
          status: "pending",
          external_reference: externalReference,
          checkout_url: null,
          mp_preapproval_id: null,
          expires_at: null
        },
        {
          onConflict: "email,device_id"
        }
      );

    if (upsertError) {
      throw upsertError;
    }

    const preference = await chamarMercadoPago("/checkout/preferences", "POST", {
      items: [
        {
          title: plano.titulo,
          quantity: 1,
          unit_price: plano.valor,
          currency_id: "BRL"
        }
      ],
      payer: {
        email
      },
      external_reference: externalReference,
      notification_url: `${BACKEND_PUBLIC_URL}/webhook/mercadopago`,
      back_urls: {
        success: BACKEND_PUBLIC_URL,
        failure: BACKEND_PUBLIC_URL,
        pending: BACKEND_PUBLIC_URL
      },
      auto_return: "approved",
      statement_descriptor: "VAGA FACIL"
    });

    const checkoutUrl =
      preference.init_point ||
      preference.sandbox_init_point ||
      null;

    const { error: updateError } = await supabase
      .from("licenses")
      .update({
        checkout_url: checkoutUrl,
        mp_preapproval_id: preference.id || null
      })
      .eq("external_reference", externalReference);

    if (updateError) {
      throw updateError;
    }

    return res.json({
      ok: true,
      checkout_url: checkoutUrl,
      external_reference: externalReference,
      preference_id: preference.id || null
    });
  } catch (error) {
    console.error("create-checkout error:", {
      message: String(error.message || error),
      details: error
    });

    return res.status(500).json({
      ok: false,
      error: "Erro ao criar checkout.",
      details: String(error.message || error)
    });
  }
});

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
      .select("email, device_id, plan, status, expires_at, updated_at, external_reference")
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

    let licencaAtual = data;

    if (data.status !== "active" && data.external_reference) {
      try {
        const pagamentoAprovado = await buscarPagamentoAprovadoPorReferencia(
          data.external_reference
        );

        if (pagamentoAprovado) {
          const ativada = await ativarLicencaPorReferencia(
            data.external_reference,
            pagamentoAprovado.id
          );

          licencaAtual = {
            ...data,
            status: "active",
            expires_at: ativada.expires_at
          };
        }
      } catch (mpError) {
        console.error("Erro ao consultar pagamento no Mercado Pago:", mpError);
      }
    }

    const agora = new Date();
    const expira = licencaAtual.expires_at
      ? new Date(licencaAtual.expires_at)
      : null;

    const active =
      licencaAtual.status === "active" &&
      expira instanceof Date &&
      !Number.isNaN(expira.getTime()) &&
      expira > agora;

    return res.json({
      ok: true,
      active,
      status: licencaAtual.status,
      plan: licencaAtual.plan,
      expires_at: licencaAtual.expires_at
    });
  } catch (error) {
    console.error("check-license error:", {
      message: String(error.message || error),
      details: error
    });

    return res.status(500).json({
      ok: false,
      active: false,
      error: "Erro ao verificar licença."
    });
  }
});

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
        reason: "Webhook sem ID do Mercado Pago."
      });
    }

    const tipo = String(eventType).toLowerCase();

    if (!tipo.includes("payment") && !tipo.includes("pagamento")) {
      return res.json({
        ok: true,
        ignored: true,
        reason: "Evento não é de pagamento.",
        eventType
      });
    }

    const pagamento = await chamarMercadoPago(`/v1/payments/${mpId}`, "GET");

    const status = String(pagamento.status || "").toLowerCase();
    const externalReference = pagamento.external_reference;

    if (!externalReference) {
      return res.json({
        ok: true,
        ignored: true,
        reason: "Pagamento sem external_reference."
      });
    }

    if (status !== "approved") {
      await supabase
        .from("licenses")
        .update({
          status: status === "cancelled" ? "cancelled" : "pending",
          mp_preapproval_id: String(mpId)
        })
        .eq("external_reference", externalReference);

      return res.json({
        ok: true,
        updated: true,
        status,
        active: false
      });
    }

    const ativada = await ativarLicencaPorReferencia(externalReference, mpId);

    return res.json({
      ok: true,
      active: true,
      ...ativada
    });
  } catch (error) {
    console.error("webhook error:", {
      message: String(error.message || error),
      details: error
    });

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
