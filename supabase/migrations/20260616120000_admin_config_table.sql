-- Tabela de configuração do painel admin (ex.: parâmetros de custos).
-- Sem políticas RLS: apenas a service_role (que ignora RLS) acessa, via a
-- Edge Function admin-api. Nenhum cliente anon/authenticated consegue ler/gravar.
create table if not exists public.admin_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.admin_config enable row level security;

-- Semente da configuração de custos (valores em BRL, editáveis pelo admin).
insert into public.admin_config (key, value)
values (
  'custos',
  '{
    "moeda": "BRL",
    "ferramentas": [
      {"id":"supabase","nome":"Supabase","ativo":false,"modelo":"fixo","valor":135,"nota":"Banco, Auth e Edge Functions. Plano Pro ~ US$25/mes. Hoje no free tier."},
      {"id":"vercel","nome":"Vercel","ativo":false,"modelo":"fixo","valor":108,"nota":"Hospedagem do front. Plano Pro ~ US$20/mes. Hoje no Hobby (gratis)."},
      {"id":"mercadopago","nome":"Mercado Pago (taxas)","ativo":true,"modelo":"percentual_receita","percentual":4.98,"nota":"Taxa de 4,98% sobre cada assinatura recebida."},
      {"id":"digitalocean","nome":"Servidor Evolution / WhatsApp","ativo":true,"modelo":"faixas_clinicas","faixas":[{"ate":10,"valor":32},{"ate":25,"valor":65},{"ate":50,"valor":130},{"ate":100,"valor":259},{"ate":null,"valor":518}],"nota":"DigitalOcean. A RAM cresce com o no de clinicas (US$6=1GB na 1a faixa). Ajuste as faixas conforme escalar."},
      {"id":"claude","nome":"API Claude / Anthropic","ativo":true,"modelo":"por_clinica_ativa","valor":3.0,"nota":"Bot de WhatsApp em Haiku 4.5 (US$1/US$5 por 1M tokens). ~R$3/clinica/mes (~200 msgs de IA). E quanto recarregar por clinica ativa."}
    ]
  }'::jsonb
)
on conflict (key) do nothing;
