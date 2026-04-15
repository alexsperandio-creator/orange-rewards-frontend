// Auto-bundled by deploy script
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// === INLINED: _shared/cors.ts ===
// Shared CORS headers for all Edge Functions
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}


// === INLINED: _shared/response.ts ===


function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function unauthorizedResponse() {
  return errorResponse('Não autorizado', 401);
}

function forbiddenResponse() {
  return errorResponse('Sem permissão para esta ação', 403);
}

// Helper: parsear query params de paginação
function parsePagination(url: URL) {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20')));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// Helper: parsear query params de busca
function parseSearch(url: URL) {
  return url.searchParams.get('q')?.trim() || '';
}

// Helper: audit log
async function logAudit(
  adminClient: any,
  userId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  oldData?: unknown,
  newData?: unknown
) {
  await adminClient.from('audit_log').insert({
    user_id: userId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    old_data: oldData || null,
    new_data: newData || null,
  });
}


// === INLINED: _shared/supabase.ts ===


// Client autenticado (respeita RLS com JWT do usuário)
function getSupabaseClient(req: Request) {
  const authHeader = req.headers.get('Authorization')!;
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );
}

// Client admin (ignora RLS, para operações de sistema)
function getSupabaseAdmin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
}

// Helper: Extrair user ID do JWT
async function getUserId(req: Request): Promise<string | null> {
  const supabase = getSupabaseClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

// Helper: Checar role do usuário
async function getUserRole(req: Request): Promise<'admin' | 'operador' | null> {
  const userId = await getUserId(req);
  if (!userId) return null;
  const admin = getSupabaseAdmin();
  const { data } = await admin.from('profiles').select('role').eq('id', userId).single();
  return data?.role ?? null;
}

// Helper: Verificar se é admin
async function requireAdmin(req: Request): Promise<boolean> {
  const role = await getUserRole(req);
  return role === 'admin';
}

// Helper: Verificar se é staff (admin ou operador)
async function requireStaff(req: Request): Promise<boolean> {
  const role = await getUserRole(req);
  return role === 'admin' || role === 'operador';
}


// === FUNCTION BODY ===
// Edge Function: /webhook-processor
// Processa eventos pendentes e envia para CRM externo
// Pode ser chamado via cron job do Supabase ou manualmente





serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const admin = getSupabaseAdmin();
  const url = new URL(req.url);

  // Verificar secret para chamadas via cron
  const cronSecret = url.searchParams.get('secret');
  const expectedSecret = Deno.env.get('WEBHOOK_CRON_SECRET');

  if (!cronSecret || cronSecret !== expectedSecret) {
    // Se não é cron, verificar se é admin
    if (!await requireAdmin(req)) return forbiddenResponse();
  }

  // ─── GET /webhook-processor/status ─── Status dos webhooks
  if (req.method === 'GET') {
    const { data: pending } = await admin
      .from('webhook_events')
      .select('id', { count: 'exact' })
      .eq('status', 'pending');

    const { data: failed } = await admin
      .from('webhook_events')
      .select('id', { count: 'exact' })
      .eq('status', 'failed');

    const { data: recent } = await admin
      .from('webhook_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    return jsonResponse({
      pending_count: pending?.length || 0,
      failed_count: failed?.length || 0,
      recent_events: recent,
    });
  }

  // ─── POST /webhook-processor ─── Processar eventos pendentes
  if (req.method === 'POST') {
    // Buscar URL do webhook configurada
    const { data: urlSetting } = await admin
      .from('system_settings')
      .select('value')
      .eq('key', 'webhook_url')
      .single();

    const webhookUrl = urlSetting?.value;
    if (!webhookUrl || webhookUrl === 'null') {
      return jsonResponse({ message: 'Webhook URL não configurada. Eventos ficam pendentes até configuração.', processed: 0 });
    }

    const { data: secretSetting } = await admin
      .from('system_settings')
      .select('value')
      .eq('key', 'webhook_secret')
      .single();
    const webhookSecret = secretSetting?.value;

    // Buscar eventos pendentes ou em retry
    const { data: events } = await admin
      .from('webhook_events')
      .select('*')
      .in('status', ['pending', 'retrying'])
      .lt('attempts', 3)
      .order('created_at')
      .limit(50);

    let sent = 0;
    let failed = 0;

    for (const event of (events || [])) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Webhook-Event': event.event_type,
          'X-Webhook-ID': event.id,
        };

        if (webhookSecret) {
          // HMAC signature para validação no destino
          const encoder = new TextEncoder();
          const key = await crypto.subtle.importKey(
            'raw', encoder.encode(webhookSecret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
          );
          const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(event.payload)));
          const sigHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
          headers['X-Webhook-Signature'] = `sha256=${sigHex}`;
        }

        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            event: event.event_type,
            data: event.payload,
            timestamp: event.created_at,
          }),
        });

        await admin.from('webhook_events').update({
          status: response.ok ? 'sent' : 'retrying',
          attempts: event.attempts + 1,
          last_attempt: new Date().toISOString(),
          response_status: response.status,
          response_body: await response.text().catch(() => ''),
        }).eq('id', event.id);

        if (response.ok) sent++;
        else failed++;

      } catch (err) {
        await admin.from('webhook_events').update({
          status: event.attempts + 1 >= 3 ? 'failed' : 'retrying',
          attempts: event.attempts + 1,
          last_attempt: new Date().toISOString(),
          response_body: String(err),
        }).eq('id', event.id);
        failed++;
      }
    }

    return jsonResponse({
      processed: (events || []).length,
      sent,
      failed,
    });
  }

  return errorResponse('Método não suportado', 405);
});
