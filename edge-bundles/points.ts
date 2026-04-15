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
// Edge Function: /points
// Crédito, débito, estorno e consulta de pontos





serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!await requireStaff(req)) return unauthorizedResponse();

  const url = new URL(req.url);
  const method = req.method;
  const supabase = getSupabaseClient(req);
  const admin = getSupabaseAdmin();
  const userId = await getUserId(req);

  // ─── GET /points ─── Listar transações com filtros
  if (method === 'GET' && !url.pathname.includes('/rules')) {
    const { limit, offset } = parsePagination(url);
    const customerId = url.searchParams.get('customer_id');
    const type = url.searchParams.get('type');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    let query = supabase
      .from('point_transactions')
      .select('*, customers(full_name, email), point_rules(name)', { count: 'exact' });

    if (customerId) query = query.eq('customer_id', customerId);
    if (type) query = query.eq('type', type);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) return errorResponse(error.message);
    return jsonResponse({ data, total: count });
  }

  // ─── GET /points/rules ─── Listar regras de pontuação
  if (method === 'GET' && url.pathname.includes('/rules')) {
    const { data, error } = await supabase
      .from('point_rules')
      .select('*')
      .order('name');

    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ─── POST /points/credit ─── Creditar pontos
  if (method === 'POST' && url.pathname.includes('/credit')) {
    const body = await req.json();

    if (!body.customer_id || !body.points || body.points <= 0) {
      return errorResponse('customer_id e points (>0) são obrigatórios');
    }

    // Se tem rule_id, buscar multiplicador
    let finalPoints = body.points;
    let ruleId = body.rule_id || null;
    let monetaryValue = body.monetary_value || null;

    if (ruleId && monetaryValue) {
      const { data: rule } = await supabase.from('point_rules').select('multiplier').eq('id', ruleId).single();
      if (rule) {
        finalPoints = Math.floor(monetaryValue * rule.multiplier);
      }
    }

    // Buscar multiplicador de tier do cliente
    const { data: customer } = await supabase
      .from('customers')
      .select('tier, category_id, customer_categories(multiplier)')
      .eq('id', body.customer_id)
      .single();

    if (!customer) return errorResponse('Cliente não encontrado', 404);

    const tierMultiplier = customer.customer_categories?.multiplier || 1;
    finalPoints = Math.floor(finalPoints * tierMultiplier);

    // Calcular expiração
    const { data: expSettings } = await admin.from('system_settings').select('value').eq('key', 'points_expiration_days').single();
    const expDays = expSettings?.value || 365;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expDays);

    const { data, error } = await supabase
      .from('point_transactions')
      .insert({
        customer_id: body.customer_id,
        rule_id: ruleId,
        type: 'credit',
        points: finalPoints,
        monetary_value: monetaryValue,
        description: body.description || 'Crédito de pontos',
        reference_id: body.reference_id || null,
        expires_at: expiresAt.toISOString(),
        created_by: userId,
      })
      .select()
      .single();

    if (error) return errorResponse(error.message);
    await logAudit(admin, userId, 'credit_points', 'point_transaction', data.id, null, data);
    return jsonResponse(data, 201);
  }

  // ─── POST /points/debit ─── Debitar pontos (resgate manual)
  if (method === 'POST' && url.pathname.includes('/debit')) {
    const body = await req.json();

    if (!body.customer_id || !body.points || body.points <= 0) {
      return errorResponse('customer_id e points (>0) são obrigatórios');
    }

    // Verificar saldo disponível
    const { data: customer } = await supabase
      .from('customers')
      .select('available_points')
      .eq('id', body.customer_id)
      .single();

    if (!customer) return errorResponse('Cliente não encontrado', 404);
    if (customer.available_points < body.points) {
      return errorResponse(`Saldo insuficiente. Disponível: ${customer.available_points}`);
    }

    const { data, error } = await supabase
      .from('point_transactions')
      .insert({
        customer_id: body.customer_id,
        type: 'debit',
        points: -Math.abs(body.points),
        description: body.description || 'Débito de pontos',
        reference_id: body.reference_id || null,
        created_by: userId,
      })
      .select()
      .single();

    if (error) return errorResponse(error.message);
    await logAudit(admin, userId, 'debit_points', 'point_transaction', data.id, null, data);
    return jsonResponse(data, 201);
  }

  // ─── POST /points/reverse ─── Estornar transação
  if (method === 'POST' && url.pathname.includes('/reverse')) {
    const body = await req.json();

    if (!body.transaction_id) return errorResponse('transaction_id é obrigatório');

    // Buscar transação original
    const { data: original } = await supabase
      .from('point_transactions')
      .select('*')
      .eq('id', body.transaction_id)
      .single();

    if (!original) return errorResponse('Transação não encontrada', 404);
    if (original.type === 'reversal') return errorResponse('Não é possível estornar um estorno');

    // Verificar se já foi estornada
    const { data: existing } = await supabase
      .from('point_transactions')
      .select('id')
      .eq('reversed_transaction_id', body.transaction_id)
      .single();

    if (existing) return errorResponse('Esta transação já foi estornada');

    const { data, error } = await supabase
      .from('point_transactions')
      .insert({
        customer_id: original.customer_id,
        type: 'reversal',
        points: -original.points,
        description: body.reason || `Estorno da transação ${original.id}`,
        reversed_transaction_id: original.id,
        created_by: userId,
      })
      .select()
      .single();

    if (error) return errorResponse(error.message);
    await logAudit(admin, userId, 'reverse_points', 'point_transaction', data.id, original, data);
    return jsonResponse(data, 201);
  }

  // ─── POST /points/bulk ─── Creditação em massa (múltiplos clientes)
  if (method === 'POST' && url.pathname.includes('/bulk')) {
    const body = await req.json();

    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      return errorResponse('entries[] é obrigatório');
    }

    const results = { success: 0, errors: [] as any[] };

    for (const entry of body.entries) {
      const { data, error } = await admin
        .from('point_transactions')
        .insert({
          customer_id: entry.customer_id,
          rule_id: entry.rule_id || null,
          type: 'credit',
          points: entry.points,
          monetary_value: entry.monetary_value || null,
          description: entry.description || 'Crédito em massa',
          reference_id: entry.reference_id || null,
          created_by: userId,
        })
        .select()
        .single();

      if (error) {
        results.errors.push({ customer_id: entry.customer_id, error: error.message });
      } else {
        results.success++;
      }
    }

    return jsonResponse(results, results.errors.length > 0 ? 207 : 201);
  }

  return errorResponse('Rota não encontrada', 404);
});
