// Script para identificar o tipo de chave Pix
// Uso: node identificarTipoPix.js <chave>

function detectarTipoChavePix(chave) {
  // E-mail
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(chave)) return 'E-mail';
  // Aleatória
  if (/^[0-9a-fA-F\-]{32,36}$/.test(chave)) return 'Aleatória';
  // CNPJ
  if (/^\d{14}$/.test(chave)) return 'CNPJ';
  // CPF (apenas 11 dígitos)
  if (/^\d{11}$/.test(chave)) return 'CPF';
  // Celular: +55DD9XXXXXXXX, 55DD9XXXXXXXX, DD9XXXXXXXX
  if (/^(\+55|55)?\d{2}9\d{8}$/.test(chave)) return 'Celular';
  return 'EVP';
}

const chave = process.argv[2];
if (!chave) {
  console.log('Uso: node identificarTipoPix.js <chave>');
  process.exit(1);
}

const tipo = detectarTipoChavePix(chave);
console.log(`Chave: ${chave}\nTipo: ${tipo}`);
