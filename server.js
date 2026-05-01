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

const MP_PLAN_MENSAL =
  process.env.MP_PLAN_MENSAL || "ca92e94590464e44b834d5bb61454732";

const MP_PLAN_TRIMESTRAL =
  process.env.MP_PLAN_TRIMESTRAL || "9786832ee8224e78b048956df6963dc2";

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
      planId: MP_PLAN_MENSAL,
      diasFallback: 35,
      checkoutUrl:
        "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_plan_id=" +
        MP_PLAN_MENSAL
    };
  }

  if (plan === "trimestral") {
    return {
      plan: "trimestral",
      titulo: "Vaga Fácil - Plano Trimestral",
      planId: MP_PLAN_TRIMESTRAL,
      diasFallback: 100,
      checkoutUrl:
        "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_plan_id=" +
        MP_PLAN_TRIMESTRAL
    };
  }

  return null;
}

function planoPorPlanId(planId) {
  if (planId === MP_PLAN_MENSAL) return dadosDoPlano("mensal");
  if (planId === MP_PLAN_TRIMESTRAL) return dadosDoPlano("trimestral");
  return null;
}

function adicionarDias(dias) {
  const data = new Date();
  data.setDate(data.getDate() + dias);
  return data.toISOString();
}

function mapearStatusAssinatura(statusMp) {
  const status = String(statusMp || "").toLowerCase();

  if (status === "authorized" || status === "active" || status === "approved") {
    return "active";
  }

  if (status === "paused") {
    return "paused";
  }

  if (status === "cancelled" || status === "canceled") {
    return "cancelled";
  }

  if (status === "expired") {
    return "expired";
  }

  return "pending";
}

function calcularExpiracao(assinatura, plano) {
  if (assinatura && assinatura.next_payment_date) {
    const data = new Date(assinatura.next_payment_date);

    if (!Number.isNaN(data.getTime())) {
      return data.toISOString();
    }
  }

  return adicionarDias(plano ? plano.diasFallback : 35);
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

async function buscarLicencaAtivaOutroAparelho(email, deviceId) {
  const { data, error } = await supabase
    .from("licenses")
    .select("device_id, status, expires_at")
    .eq("email", email)
    .eq("status", "active")
    .neq("device_id", deviceId);

  if (error) {
    throw error;
  }

  const agora = new Date();

  return (data || []).some((item) => {
    if (!item.expires_at) return false;

    const expira = new Date(item.expires_at);

    return (
      item.device_id &&
      item.device_id !== deviceId &&
      !Number.isNaN(expira.getTime()) &&
      expira > agora
    );
  });
}

async function buscarAssinaturaAtivaPorEmailEPlano(email, plano) {
  const params = new URLSearchParams();
  params.set("payer_email", email);
  params.set("preapproval_plan_id", plano.planId);
  params.set("limit", "20");

  const resultado = await chamarMercadoPago(
    `/preapproval/search?${params.toString()}`,
    "GET"
  );

  const assinaturas = Array.isArray(resultado.results)
    ? resultado.results
    : [];

  console.log("Busca assinatura:", {
    email,
    plano: plano.plan,
    total: assinaturas.length
  });

  const ativas = assinaturas
    .filter((assinatura) => {
      const status = String(assinatura.status || "").toLowerCase();

      return (
        assinatura.preapproval_plan_id === plano.planId &&
        (status === "authorized" || status === "active")
      );
    })
    .sort((a, b) => {
      const dataA = new Date(a.date_created || a.last_modified || 0).getTime();
      const dataB = new Date(b.date_created || b.last_modified || 0).getTime();
      return dataB - dataA;
    });

  return ativas[0] || null;
}

async function buscarAssinaturaAtivaPorEmail(email, planoPreferido = null) {
  const planos = [];

  if (planoPreferido) {
    const plano = dadosDoPlano(planoPreferido);
    if (plano) planos.push(plano);
  }

  if (!planos.some((p) => p.plan === "mensal")) {
    planos.push(dadosDoPlano("mensal"));
  }

  if (!planos.some((p) => p.plan === "trimestral")) {
    planos.push(dadosDoPlano("trimestral"));
  }

  for (const plano of planos) {
    if (!plano) continue;

    const assinatura = await buscarAssinaturaAtivaPorEmailEPlano(email, plano);

    if (assinatura) {
      return {
        assinatura,
        plano
      };
    }
  }

  return null;
}

async function ativarLicencaComAssinatura({
  email,
  deviceId,
  plano,
  assinatura
}) {
  const outroAparelho = await buscarLicencaAtivaOutroAparelho(email, deviceId);

  if (outroAparelho) {
    return {
      ok: false,
      active: false,
      status: "email_usado_em_outro_aparelho",
      plan: plano.plan,
      expires_at: null
    };
  }

  const status = mapearStatusAssinatura(assinatura.status);
  const expiresAt =
    status === "active" ? calcularExpiracao(assinatura, plano) : null;

  const { error } = await supabase
    .from("licenses")
    .update({
      plan: plano.plan,
      status,
      mp_preapproval_id: assinatura.id || null,
      expires_at: expiresAt
    })
    .eq("email", email)
    .eq("device_id", deviceId);

  if (error) {
    throw error;
  }

  return {
    ok: true,
    active: status === "active",
    status,
    plan: plano.plan,
    expires_at: expiresAt
  };
}

async function processarAssinaturaMercadoPago(assinatura) {
  const planId = assinatura.preapproval_plan_id;
  const plano = planoPorPlanId(planId);

  if (!plano) {
    return {
      updated: false,
      reason: "Plano não reconhecido.",
      planId
    };
  }

  const email = limparEmail(
    assinatura.payer_email ||
      assinatura.payer?.email ||
      assinatura.subscriber?.email
  );

  if (!email) {
    return {
      updated: false,
      reason: "Assinatura sem e-mail."
    };
  }

  const status = mapearStatusAssinatura(assinatura.status);
  const expiresAt =
    status === "active" ? calcularExpiracao(assinatura, plano) : null;

  let { data: licenca, error: erroBusca } = await supabase
    .from("licenses")
    .select("*")
    .eq("mp_preapproval_id", assinatura.id)
    .maybeSingle();

  if (erroBusca) {
    throw erroBusca;
  }

  if (!licenca) {
    const buscaPendente = await supabase
      .from("licenses")
      .select("*")
      .eq("email", email)
      .eq("plan", plano.plan)
      .in("status", ["pending", "active", "paused"])
      .order("updated_at", { ascending: false })
      .limit(1);

    if (buscaPendente.error) {
      throw buscaPendente.error;
    }

    licenca = buscaPendente.data && buscaPendente.data[0];
  }

  if (!licenca) {
    return {
      updated: false,
      reason: "Nenhuma licença pendente encontrada para esse e-mail."
    };
  }

  const { error: updateError } = await supabase
    .from("licenses")
    .update({
      plan: plano.plan,
      status,
      mp_preapproval_id: assinatura.id || null,
      expires_at: expiresAt
    })
    .eq("id", licenca.id);

  if (updateError) {
    throw updateError;
  }

  return {
    updated: true,
    email,
    device_id: licenca.device_id,
    status,
    plan: plano.plan,
    expires_at: expiresAt
  };
}

async function processarPagamentoMercadoPago(pagamento) {
  const email = limparEmail(pagamento.payer?.email || "");

  if (!email) {
    return {
      updated: false,
      reason: "Pagamento sem e-mail do pagador."
    };
  }

  const resultado = await buscarAssinaturaAtivaPorEmail(email);

  if (!resultado) {
    return {
      updated: false,
      reason: "Nenhuma assinatura ativa encontrada para o e-mail."
    };
  }

  const { assinatura, plano } = resultado;

  const { data: licencas, error } = await supabase
    .from("licenses")
    .select("*")
    .eq("email", email)
    .eq("plan", plano.plan)
    .in("status", ["pending", "active", "paused"])
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) {
    throw error;
  }

  const licenca = licencas && licencas[0];

  if (!licenca) {
    return {
      updated: false,
      reason: "Licença não encontrada para o pagamento."
    };
  }

  return ativarLicencaComAssinatura({
    email,
    deviceId: licenca.device_id,
    plano,
    assinatura
  });
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "Vaga Fácil Backend",
    status: "online",
    mode: "recurring-subscription-v3-plan-link"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    mode: "recurring-subscription-v3-plan-link",
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

    if (!plano || !plano.planId) {
      return res.status(400).json({
        ok: false,
        error: "Plano inválido."
      });
    }

    const outroAparelho = await buscarLicencaAtivaOutroAparelho(
      email,
      deviceId
    );

    if (outroAparelho) {
      return res.status(403).json({
        ok: false,
        error:
          "Este e-mail já está vinculado a outro aparelho ativo. Fale com o suporte."
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
          checkout_url: plano.checkoutUrl,
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

    return res.json({
      ok: true,
      recurring: true,
      checkout_url: plano.checkoutUrl,
      external_reference: externalReference,
      plan: plano.plan,
      message:
        "Use no Mercado Pago o mesmo e-mail informado no app para liberar automaticamente."
    });
  } catch (error) {
    console.error("create-checkout error:", {
      message: String(error.message || error),
      details: error
    });

    return res.status(500).json({
      ok: false,
      error: "Erro ao criar checkout recorrente.",
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
      .select(
        "id, email, device_id, plan, status, expires_at, updated_at, external_reference, mp_preapproval_id"
      )
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

    const agora = new Date();
    const expiraAtual = licencaAtual.expires_at
      ? new Date(licencaAtual.expires_at)
      : null;

    const aindaAtiva =
      licencaAtual.status === "active" &&
      expiraAtual instanceof Date &&
      !Number.isNaN(expiraAtual.getTime()) &&
      expiraAtual > agora;

    if (!aindaAtiva) {
      try {
        let ativada = null;

        if (data.mp_preapproval_id) {
          const assinatura = await chamarMercadoPago(
            `/preapproval/${data.mp_preapproval_id}`,
            "GET"
          );

          const plano =
            planoPorPlanId(assinatura.preapproval_plan_id) ||
            dadosDoPlano(data.plan);

          if (plano) {
            ativada = await ativarLicencaComAssinatura({
              email,
              deviceId,
              plano,
              assinatura
            });
          }
        }

        if (!ativada || !ativada.active) {
          const resultado = await buscarAssinaturaAtivaPorEmail(
            email,
            data.plan
          );

          if (resultado) {
            ativada = await ativarLicencaComAssinatura({
              email,
              deviceId,
              plano: resultado.plano,
              assinatura: resultado.assinatura
            });
          }
        }

        if (ativada) {
          if (!ativada.ok) {
            return res.json({
              ok: true,
              active: false,
              status: ativada.status,
              plan: ativada.plan,
              expires_at: null
            });
          }

          licencaAtual = {
            ...licencaAtual,
            status: ativada.status,
            plan: ativada.plan,
            expires_at: ativada.expires_at
          };
        }
      } catch (mpError) {
        console.error("Erro ao consultar assinatura no Mercado Pago:", {
          message: String(mpError.message || mpError),
          details: mpError
        });
      }
    }

    const expira = licencaAtual.expires_at
      ? new Date(licencaAtual.expires_at)
      : null;

    const active =
      licencaAtual.status === "active" &&
      expira instanceof Date &&
      !Number.isNaN(expira.getTime()) &&
      expira > new Date();

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

    if (
      tipo.includes("preapproval") ||
      tipo.includes("subscription") ||
      tipo.includes("assinatura") ||
      tipo.includes("plan")
    ) {
      const assinatura = await chamarMercadoPago(`/preapproval/${mpId}`, "GET");
      const resultado = await processarAssinaturaMercadoPago(assinatura);

      return res.json({
        ok: true,
        eventType,
        ...resultado
      });
    }

    if (tipo.includes("payment") || tipo.includes("pagamento")) {
      const pagamento = await chamarMercadoPago(`/v1/payments/${mpId}`, "GET");
      const resultado = await processarPagamentoMercadoPago(pagamento);

      return res.json({
        ok: true,
        eventType,
        ...resultado
      });
    }

    return res.json({
      ok: true,
      ignored: true,
      reason: "Evento não tratado.",
      eventType
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
