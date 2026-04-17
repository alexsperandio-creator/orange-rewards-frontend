#!/bin/bash
# Build script para Netlify (ou qualquer CI)
# Gera o config.js a partir das variáveis de ambiente do deploy

echo "Gerando config.js para ambiente: ${DEPLOY_ENV:-staging}"

cat > config.js << EOF
/**
 * Orange Rewards - Configuração de Ambiente
 * Gerado automaticamente pelo build.sh
 */
const SUPABASE_URL = '${SUPABASE_URL}';
const SUPABASE_ANON_KEY = '${SUPABASE_ANON_KEY}';
const API_BASE = SUPABASE_URL + '/functions/v1';
EOF

echo "config.js gerado com SUPABASE_URL=${SUPABASE_URL}"
