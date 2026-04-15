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
// Edge Function: /marketing
// Templates de e-mail, automações e pesquisas





serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!await requireStaff(req)) return unauthorizedResponse();

  const url = new URL(req.url);
  const method = req.method;
  const supabase = getSupabaseClient(req);
  const admin = getSupabaseAdmin();
  const userId = await getUserId(req);

  // ═══════════════ TEMPLATES ═══════════════

  // GET /marketing/templates
  if (method === 'GET' && url.pathname.includes('/templates')) {
    const { data, error } = await supabase
      .from('email_templates')
      .select('*')
      .order('name');
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // POST /marketing/templates
  if (method === 'POST' && url.pathname.includes('/templates')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const body = await req.json();
    const { data, error } = await supabase
      .from('email_templates')
      .insert({
        name: body.name,
        slug: body.slug || body.name.toLowerCase().replace(/\s+/g, '-'),
        subject: body.subject,
        body_html: body.body_html,
        body_text: body.body_text,
        variables: body.variables || [],
      })
      .select().single();
    if (error) return errorResponse(error.message);
    return jsonResponse(data, 201);
  }

  // PUT /marketing/templates/:id
  if ((method === 'PUT' || method === 'PATCH') && url.pathname.includes('/templates/')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const id = url.pathname.split('/').pop();
    const body = await req.json();
    const { data, error } = await supabase
      .from('email_templates')
      .update(body)
      .eq('id', id)
      .select().single();
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ═══════════════ AUTOMAÇÕES ═══════════════

  // GET /marketing/automations
  if (method === 'GET' && url.pathname.includes('/automations')) {
    const id = url.pathname.split('/').pop();
    const isDetail = id && id !== 'automations';

    if (isDetail) {
      const { data, error } = await supabase
        .from('automations')
        .select('*, email_templates(name, subject)')
        .eq('id', id)
        .single();
      if (error) return errorResponse(error.message, 404);

      // Buscar logs recentes
      const { data: logs } = await supabase
        .from('automation_logs')
        .select('*, customers(full_name)')
        .eq('automation_id', id)
        .order('created_at', { ascending: false })
        .limit(50);

      return jsonResponse({ ...data, logs });
    }

    const { data, error } = await supabase
      .from('automations')
      .select('*, email_templates(name)')
      .order('name');
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // POST /marketing/automations
  if (method === 'POST' && url.pathname.includes('/automations') && !url.pathname.includes('/run')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const body = await req.json();
    const { data, error } = await supabase
      .from('automations')
      .insert({
        name: body.name,
        description: body.description,
        trigger: body.trigger,
        trigger_config: body.trigger_config || {},
        template_id: body.template_id,
        action_type: body.action_type || 'email',
        action_config: body.action_config || {},
        target_tiers: body.target_tiers || ['basic','gold','platinum','prime','select'],
        status: body.status || 'draft',
      })
      .select().single();
    if (error) return errorResponse(error.message);
    return jsonResponse(data, 201);
  }

  // PUT /marketing/automations/:id
  if ((method === 'PUT' || method === 'PATCH') && url.pathname.includes('/automations/') && !url.pathname.includes('/run')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const id = url.pathname.split('/').pop();
    const body = await req.json();
    const { data, error } = await supabase
      .from('automations')
      .update(body)
      .eq('id', id)
      .select().single();
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // POST /marketing/automations/:id/run ─── Executar manualmente
  if (method === 'POST' && url.pathname.includes('/run')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const id = url.pathname.split('/').slice(-2)[0];

    const { data: automation } = await supabase
      .from('automations')
      .select('*, email_templates(*)')
      .eq('id', id)
      .single();

    if (!automation) return errorResponse('Automação não encontrada', 404);

    // Buscar clientes alvo
    const { data: customers } = await admin
      .from('customers')
      .select('id, full_name, email')
      .eq('is_active', true)
      .in('tier', automation.target_tiers || [])
      .not('email', 'is', null);

    let sent = 0;
    const errors: string[] = [];

    for (const customer of (customers || [])) {
      // Aqui seria a integração real com serviço de e-mail (Resend, SendGrid, etc.)
      // Por agora, registramos o log
      const { error } = await admin.from('automation_logs').insert({
        automation_id: id,
        customer_id: customer.id,
        status: 'sent', // Em produção: verificar retorno do serviço de e-mail
        metadata: { email: customer.email, template: automation.email_templates?.slug },
      });

      if (error) errors.push(`${customer.email}: ${error.message}`);
      else sent++;
    }

    // Atualizar contadores da automação
    await admin.from('automations').update({
      last_run: new Date().toISOString(),
      run_count: automation.run_count + 1,
    }).eq('id', id);

    await logAudit(admin, userId, 'run_automation', 'automation', id, null, { sent, errors: errors.length });

    return jsonResponse({ automation_id: id, customers_targeted: (customers || []).length, sent, errors: errors.length });
  }

  // ═══════════════ PESQUISAS ═══════════════

  // GET /marketing/surveys
  if (method === 'GET' && url.pathname.includes('/surveys')) {
    const { data, error } = await supabase.from('surveys').select('*').order('created_at', { ascending: false });
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // POST /marketing/surveys
  if (method === 'POST' && url.pathname.includes('/surveys')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const body = await req.json();
    const { data, error } = await supabase.from('surveys').insert({
      title: body.title,
      description: body.description,
      questions: body.questions || [],
      bonus_points: body.bonus_points || 0,
      target_tiers: body.target_tiers,
      status: body.status || 'draft',
      starts_at: body.starts_at,
      ends_at: body.ends_at,
    }).select().single();
    if (error) return errorResponse(error.message);
    return jsonResponse(data, 201);
  }

  return errorResponse('Rota não encontrada', 404);
});
