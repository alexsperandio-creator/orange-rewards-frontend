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
// Edge Function: /redemptions
// Resgates: criar, aprovar, entregar, cancelar





serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!await requireStaff(req)) return unauthorizedResponse();

  const url = new URL(req.url);
  const method = req.method;
  const supabase = getSupabaseClient(req);
  const admin = getSupabaseAdmin();
  const userId = await getUserId(req);

  // ─── GET /redemptions ─── Listar resgates
  if (method === 'GET' && !url.pathname.match(/\/[0-9a-f-]{36}$/)) {
    const { limit, offset } = parsePagination(url);
    const status = url.searchParams.get('status');
    const customerId = url.searchParams.get('customer_id');

    let query = supabase
      .from('redemptions')
      .select('*, customers(full_name, email, tier), prizes(name, image_url, points_required)', { count: 'exact' });

    if (status) query = query.eq('status', status);
    if (customerId) query = query.eq('customer_id', customerId);

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) return errorResponse(error.message);
    return jsonResponse({ data, total: count });
  }

  // ─── POST /redemptions ─── Criar resgate
  if (method === 'POST' && !url.pathname.includes('/approve') && !url.pathname.includes('/deliver') && !url.pathname.includes('/cancel')) {
    const body = await req.json();

    if (!body.customer_id || !body.prize_id) {
      return errorResponse('customer_id e prize_id são obrigatórios');
    }

    // Buscar prêmio
    const { data: prize } = await supabase.from('prizes').select('*').eq('id', body.prize_id).single();
    if (!prize) return errorResponse('Prêmio não encontrado', 404);
    if (!prize.is_active) return errorResponse('Prêmio indisponível');
    if (prize.stock !== null && prize.stock <= 0) return errorResponse('Prêmio sem estoque');

    // Verificar tier mínimo
    const { data: customer } = await supabase
      .from('customers')
      .select('available_points, tier')
      .eq('id', body.customer_id)
      .single();

    if (!customer) return errorResponse('Cliente não encontrado', 404);

    const tierOrder = ['basic', 'gold', 'platinum', 'prime', 'select'];
    if (tierOrder.indexOf(customer.tier) < tierOrder.indexOf(prize.min_tier || 'basic')) {
      return errorResponse(`Tier mínimo: ${prize.min_tier}. Cliente é ${customer.tier}`);
    }

    // Verificar saldo
    if (customer.available_points < prize.points_required) {
      return errorResponse(`Saldo insuficiente. Necessário: ${prize.points_required}, Disponível: ${customer.available_points}`);
    }

    // Verificar limite por cliente
    if (prize.max_per_customer) {
      const { count } = await supabase
        .from('redemptions')
        .select('id', { count: 'exact' })
        .eq('customer_id', body.customer_id)
        .eq('prize_id', body.prize_id)
        .neq('status', 'cancelled');

      if ((count || 0) >= prize.max_per_customer) {
        return errorResponse(`Limite de ${prize.max_per_customer} resgates por cliente atingido`);
      }
    }

    // Debitar pontos
    await admin.from('point_transactions').insert({
      customer_id: body.customer_id,
      type: 'debit',
      points: -prize.points_required,
      description: `Resgate: ${prize.name}`,
      created_by: userId,
    });

    // Criar resgate
    const { data, error } = await supabase
      .from('redemptions')
      .insert({
        customer_id: body.customer_id,
        prize_id: body.prize_id,
        points_spent: prize.points_required,
        notes: body.notes,
      })
      .select('*, customers(full_name), prizes(name)')
      .single();

    if (error) return errorResponse(error.message);
    await logAudit(admin, userId, 'create', 'redemption', data.id, null, data);
    return jsonResponse(data, 201);
  }

  // ─── POST /redemptions/:id/approve ─── Aprovar resgate
  if (method === 'POST' && url.pathname.includes('/approve')) {
    const id = url.pathname.split('/').slice(-2)[0];

    const { data, error } = await supabase
      .from('redemptions')
      .update({
        status: 'approved',
        approved_by: userId,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select()
      .single();

    if (error || !data) return errorResponse('Resgate não encontrado ou já processado', 404);
    await logAudit(admin, userId, 'approve', 'redemption', id, null, data);
    return jsonResponse(data);
  }

  // ─── POST /redemptions/:id/deliver ─── Marcar como entregue
  if (method === 'POST' && url.pathname.includes('/deliver')) {
    const id = url.pathname.split('/').slice(-2)[0];

    const { data, error } = await supabase
      .from('redemptions')
      .update({
        status: 'delivered',
        delivered_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'approved')
      .select()
      .single();

    if (error || !data) return errorResponse('Resgate não encontrado ou não aprovado', 404);
    await logAudit(admin, userId, 'deliver', 'redemption', id, null, data);
    return jsonResponse(data);
  }

  // ─── POST /redemptions/:id/cancel ─── Cancelar resgate (devolve pontos)
  if (method === 'POST' && url.pathname.includes('/cancel')) {
    const id = url.pathname.split('/').slice(-2)[0];
    const body = await req.json().catch(() => ({}));

    const { data: redemption } = await supabase
      .from('redemptions')
      .select('*')
      .eq('id', id)
      .single();

    if (!redemption) return errorResponse('Resgate não encontrado', 404);
    if (redemption.status === 'cancelled') return errorResponse('Resgate já cancelado');
    if (redemption.status === 'delivered') return errorResponse('Não é possível cancelar resgate já entregue');

    // Devolver pontos
    await admin.from('point_transactions').insert({
      customer_id: redemption.customer_id,
      type: 'credit',
      points: redemption.points_spent,
      description: `Devolução: cancelamento do resgate ${id}`,
      created_by: userId,
    });

    const { data, error } = await supabase
      .from('redemptions')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: body.reason || 'Cancelado pelo operador',
      })
      .eq('id', id)
      .select()
      .single();

    if (error) return errorResponse(error.message);
    await logAudit(admin, userId, 'cancel', 'redemption', id, redemption, data);
    return jsonResponse(data);
  }

  return errorResponse('Rota não encontrada', 404);
});
