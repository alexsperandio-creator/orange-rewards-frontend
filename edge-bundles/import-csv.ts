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
// Edge Function: /import-csv
// Importação em massa de pedidos/clientes via CSV (separador ;)





// Parser de CSV com separador ;
function parseCSV(text: string, separator = ';'): { headers: string[], rows: Record<string, string>[] } {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = lines[0].split(separator).map(h => h.trim().toLowerCase().replace(/["\s]/g, '').replace(/[àáâã]/g, 'a').replace(/[éê]/g, 'e').replace(/[íî]/g, 'i').replace(/[óôõ]/g, 'o').replace(/[úû]/g, 'u').replace(/ç/g, 'c'));

  const rows = lines.slice(1).map(line => {
    const values = line.split(separator).map(v => v.trim().replace(/^"|"$/g, ''));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });

  return { headers, rows };
}

// Normalizar CPF
function normalizeCPF(cpf: string): string {
  return cpf.replace(/\D/g, '');
}

// Normalizar telefone
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!await requireAdmin(req)) return forbiddenResponse();

  const url = new URL(req.url);
  const method = req.method;
  const admin = getSupabaseAdmin();
  const userId = await getUserId(req);

  // ─── GET /import-csv ─── Listar logs de importação
  if (method === 'GET') {
    const { data, error } = await admin
      .from('import_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ─── POST /import-csv/orders ─── Importar pedidos (crédito de pontos)
  if (method === 'POST' && url.pathname.includes('/orders')) {
    const body = await req.json();
    const csvText = body.csv_content;
    const fileName = body.file_name || 'import.txt';

    if (!csvText) return errorResponse('csv_content é obrigatório');

    const { headers, rows } = parseCSV(csvText, ';');

    // Criar log de importação
    const { data: importLog } = await admin
      .from('import_logs')
      .insert({
        file_name: fileName,
        import_type: 'orders',
        total_rows: rows.length,
        status: 'processing',
        imported_by: userId,
      })
      .select()
      .single();

    let successCount = 0;
    const errors: any[] = [];

    // Mapear headers esperados
    // CPF/CNPJ ; Nome ; Email ; Telefone ; Produto ; Valor ; Data ; Referência
    const cpfCol = headers.find(h => h.includes('cpf') || h.includes('cnpj') || h.includes('documento'));
    const nameCol = headers.find(h => h.includes('nome') || h.includes('name') || h.includes('cliente'));
    const emailCol = headers.find(h => h.includes('email') || h.includes('e-mail'));
    const phoneCol = headers.find(h => h.includes('telefone') || h.includes('phone') || h.includes('celular') || h.includes('fone'));
    const productCol = headers.find(h => h.includes('produto') || h.includes('servico') || h.includes('product') || h.includes('tipo'));
    const valueCol = headers.find(h => h.includes('valor') || h.includes('value') || h.includes('total') || h.includes('preco'));
    const dateCol = headers.find(h => h.includes('data') || h.includes('date'));
    const refCol = headers.find(h => h.includes('referencia') || h.includes('pedido') || h.includes('order') || h.includes('nf'));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const cpf = cpfCol ? normalizeCPF(row[cpfCol]) : '';
        const name = nameCol ? row[nameCol] : '';
        const email = emailCol ? row[emailCol] : '';
        const phone = phoneCol ? normalizePhone(row[phoneCol]) : '';
        const product = productCol ? row[productCol] : '';
        const valueStr = valueCol ? row[valueCol].replace(/[^\d,.-]/g, '').replace(',', '.') : '0';
        const value = parseFloat(valueStr) || 0;
        const reference = refCol ? row[refCol] : '';

        if (!name && !cpf && !email) {
          errors.push({ row: i + 2, message: 'Linha sem identificação (nome, CPF ou email)' });
          continue;
        }

        // Buscar ou criar cliente
        let customerId: string | null = null;

        if (cpf) {
          const { data: existing } = await admin.from('customers').select('id').eq('cpf', cpf).single();
          customerId = existing?.id;
        }
        if (!customerId && email) {
          const { data: existing } = await admin.from('customers').select('id').eq('email', email).single();
          customerId = existing?.id;
        }

        // Criar se não existe
        if (!customerId) {
          const { data: newCustomer, error: custErr } = await admin
            .from('customers')
            .insert({
              full_name: name || 'Sem Nome',
              email: email || null,
              cpf: cpf || null,
              phone: phone || null,
            })
            .select('id')
            .single();

          if (custErr) {
            errors.push({ row: i + 2, message: `Erro ao criar cliente: ${custErr.message}` });
            continue;
          }
          customerId = newCustomer.id;
        }

        // Buscar regra de pontuação pelo produto
        let ruleId: string | null = null;
        let multiplier = 1;

        if (product) {
          const { data: rule } = await admin
            .from('point_rules')
            .select('id, multiplier')
            .or(`code.ilike.%${product}%,name.ilike.%${product}%`)
            .limit(1)
            .single();

          if (rule) {
            ruleId = rule.id;
            multiplier = rule.multiplier;
          }
        }

        // Calcular pontos
        const points = Math.floor(value * multiplier);
        if (points <= 0) {
          errors.push({ row: i + 2, message: `Valor inválido: ${value}` });
          continue;
        }

        // Expiração
        const expiresAt = new Date();
        expiresAt.setFullYear(expiresAt.getFullYear() + 1);

        // Creditar pontos
        await admin.from('point_transactions').insert({
          customer_id: customerId,
          rule_id: ruleId,
          type: 'credit',
          points,
          monetary_value: value,
          description: `Importação: ${product || 'pedido'} ${reference || ''}`.trim(),
          reference_id: reference || null,
          expires_at: expiresAt.toISOString(),
          created_by: userId,
        });

        successCount++;
      } catch (err) {
        errors.push({ row: i + 2, message: String(err) });
      }
    }

    // Atualizar log
    await admin.from('import_logs').update({
      processed_rows: rows.length,
      success_rows: successCount,
      error_rows: errors.length,
      status: errors.length === 0 ? 'completed' : (successCount > 0 ? 'partial' : 'failed'),
      errors: errors.slice(0, 100), // Limitar a 100 erros no log
      completed_at: new Date().toISOString(),
    }).eq('id', importLog!.id);

    await logAudit(admin, userId, 'import', 'import_log', importLog!.id, null, {
      file_name: fileName,
      total: rows.length,
      success: successCount,
      errors: errors.length,
    });

    return jsonResponse({
      import_id: importLog!.id,
      total_rows: rows.length,
      success: successCount,
      errors: errors.length,
      error_details: errors.slice(0, 20),
    });
  }

  // ─── POST /import-csv/clients ─── Importar somente clientes (sem pontos)
  if (method === 'POST' && url.pathname.includes('/clients')) {
    const body = await req.json();
    const { rows } = parseCSV(body.csv_content, ';');

    const { data: importLog } = await admin.from('import_logs').insert({
      file_name: body.file_name || 'clients.txt',
      import_type: 'clients',
      total_rows: rows.length,
      status: 'processing',
      imported_by: userId,
    }).select().single();

    let success = 0;
    const errs: any[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = Object.values(r).find((_, ki) => Object.keys(r)[ki].includes('nome')) || '';
      const email = Object.values(r).find((_, ki) => Object.keys(r)[ki].includes('email')) || null;
      const cpf = Object.values(r).find((_, ki) => Object.keys(r)[ki].includes('cpf'));
      const phone = Object.values(r).find((_, ki) => Object.keys(r)[ki].includes('telefone') || Object.keys(r)[ki].includes('celular'));

      if (!name) { errs.push({ row: i+2, message: 'Nome obrigatório' }); continue; }

      const { error } = await admin.from('customers').insert({
        full_name: name,
        email: email || null,
        cpf: cpf ? normalizeCPF(cpf) : null,
        phone: phone ? normalizePhone(phone) : null,
      });

      if (error) errs.push({ row: i+2, message: error.message });
      else success++;
    }

    await admin.from('import_logs').update({
      processed_rows: rows.length, success_rows: success, error_rows: errs.length,
      status: errs.length === 0 ? 'completed' : (success > 0 ? 'partial' : 'failed'),
      errors: errs.slice(0, 100), completed_at: new Date().toISOString(),
    }).eq('id', importLog!.id);

    return jsonResponse({ import_id: importLog!.id, total: rows.length, success, errors: errs.length });
  }

  return errorResponse('Rota não encontrada', 404);
});
