require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits } = require('discord.js');
const qrcode = require('qrcode');
const { Configuration, OpenAIApi } = require('openai');
const fetch = require('node-fetch'); // Certifique-se de ter node-fetch instalado

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const DB_FILE = './database.json';

function loadDatabase() {
  if (!fs.existsSync(DB_FILE)) return {};
  const raw = fs.readFileSync(DB_FILE);
  const db = JSON.parse(raw);
  // Compatibilidade retroativa: se valor for string, converte para objeto
  for (const k in db) {
    if (typeof db[k] === 'string') {
      db[k] = { chave: db[k], tipo: detectarTipoChavePix(db[k]) };
    }
  }
  return db;
}

function saveDatabase(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Função para gerar payload Pix manualmente
function gerarPayloadPix({ key, name, city, value, description = '', txid = '' }) {
  // Limites e padrões do Banco Central
  name = name.substring(0, 25);
  city = city.substring(0, 15);
  description = description.substring(0, 99);
  txid = txid.substring(0, 25);

  // Montagem do payload
  function format(id, value) {
    const size = value.length.toString().padStart(2, '0');
    return `${id}${size}${value}`;
  }

  // Merchant Account Information (GUI + chave + description)
  let merchant = format('00', 'BR.GOV.BCB.PIX') + format('01', key);
  if (description) merchant += format('02', description);

  // Additional Data Field (txid)
  let additional = '';
  if (txid) additional = format('05', txid);

  // Payload base
  let payload = '';
  payload += format('00', '01'); // Payload Format Indicator
  payload += format('26', merchant); // Merchant Account Information
  payload += format('52', '0000'); // Merchant Category Code
  payload += format('53', '986'); // Transaction Currency (BRL)
  if (value) payload += format('54', value.toFixed(2)); // Transaction Amount
  payload += format('58', 'BR'); // Country Code
  payload += format('59', name); // Merchant Name
  payload += format('60', city); // Merchant City
  if (additional) payload += format('62', additional); // Additional Data Field
  payload += '6304'; // CRC placeholder

  // Função para calcular CRC16
  function crc16(str) {
    let crc = 0xFFFF;
    for (let c of str) {
      crc ^= c.charCodeAt(0) << 8;
      for (let i = 0; i < 8; i++) {
        if ((crc & 0x8000) !== 0) {
          crc = (crc << 1) ^ 0x1021;
        } else {
          crc <<= 1;
        }
        crc &= 0xFFFF;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  const crc = crc16(payload);
  return payload + crc;
}

// Função utilitária para detectar o tipo de chave Pix
function detectarTipoChavePix(chave) {
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(chave)) return 'email';
  if (/^[0-9a-fA-F\-]{32,36}$/.test(chave)) return 'aleatoria';
  if (/^\d{14}$/.test(chave)) return 'cnpj';
  // Celular: +55DD9XXXXXXXX, 55DD9XXXXXXXX, DD9XXXXXXXX, DDD9XXXXXXXX
  if (/^(\+55|55)?\d{2}9\d{8}$/.test(chave)) return 'cel';
  // CPF: exatamente 11 dígitos, mas não pode ser DDD9XXXXXXXX
  if (/^\d{11}$/.test(chave) && !/^\d{2}9\d{8}$/.test(chave)) return 'cpf';
  return 'evp';
}

// Lista de IDs dos cargos permitidos a usar o bot
const allowedRoleIds = ['1368602269985275904']; // Substitua pelos IDs dos cargos desejados

// Canal de log configurável
let pixLogChannelId = null;

// Mapa para armazenar estado de registro aguardando tipo/chave por usuário
const REG_STATE_FILE = './registro_state.json';

function loadRegistroState() {
  if (!fs.existsSync(REG_STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(REG_STATE_FILE));
}

function saveRegistroState(state) {
  fs.writeFileSync(REG_STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Otimização: Carregar o banco de dados e o estado de registro uma vez em memória ---
let db = loadDatabase();
let aguardandoRegistro = loadRegistroState();

// Atualizar funções para usar as variáveis em memória
function saveDatabaseMem() {
  saveDatabase(db);
}
function saveRegistroStateMem() {
  saveRegistroState(aguardandoRegistro);
}

const OPENAI_KEY = process.env.OPENAI_API_KEY;
let openai = null;
if (OPENAI_KEY) {
  openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_KEY }));
}

// --- Gemini API ---
const GEMINI_KEY = process.env.GEMINI_API_KEY;
let geminiEnabled = !!GEMINI_KEY;

async function iaResponderGemini(mensagem, usuario, channel) {
  if (!geminiEnabled) return null;
  // Busca contexto semelhante ao OpenAI
  const historico = await getRecentMessagesForContext(channel, 100);
  const prompt = historico.map(m => `${m.author}: ${m.content}`).join('\n') + `\n@${usuario}: ${mensagem}`;
  // Exemplo de prompt e chamada para Gemini (ajuste conforme a API real)
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=' + GEMINI_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 180
        }
      })
    });
    const data = await response.json();
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
      return data.candidates[0].content.parts.map(p => p.text).join(' ').trim();
    }
    return null;
  } catch (e) {
    console.error('Erro Gemini:', e.message);
    return null;
  }
}

// Função combinada: consulta OpenAI e Gemini, retorna a mais relevante (aqui: prioriza OpenAI, mas pode ser ajustado)
async function iaResponderCombinada(mensagem, usuario, channel) {
  const [resOpenAI, resGemini] = await Promise.all([
    iaResponder(mensagem, usuario, channel),
    iaResponderGemini(mensagem, usuario, channel)
  ]);
  // Lógica simples: se OpenAI falhar, usa Gemini; pode ser aprimorada para comparar relevância
  if (resOpenAI && resGemini) {
    // Exemplo: retorna ambas, ou escolha uma lógica de "melhor resposta"
    return `${resOpenAI}\n\n_Gemini também sugere:_\n${resGemini}`;
  }
  return resOpenAI || resGemini || 'Desculpe, não consegui gerar uma resposta agora.';
}

// Função para buscar o máximo de mensagens do canal para contexto IA
async function getRecentMessagesForContext(channel, limit = 100) {
  let messages = [];
  let lastId = undefined;
  while (messages.length < limit) {
    const options = { limit: Math.min(100, limit - messages.length) };
    if (lastId) options.before = lastId;
    const fetched = await channel.messages.fetch(options);
    if (fetched.size === 0) break;
    messages = messages.concat(Array.from(fetched.values()));
    lastId = fetched.last()?.id;
    if (!lastId) break;
  }
  // Ordena do mais antigo para o mais recente
  return messages.reverse().map(msg => ({
    author: msg.author.username,
    content: msg.content
  }));
}

async function iaResponder(mensagem, usuario, channel) {
  if (!openai) return null;
  // Busca o máximo de contexto possível (até 100 mensagens)
  const historico = await getRecentMessagesForContext(channel, 100);
  const chatHistory = historico.map(m => ({ role: 'user', content: `${m.author}: ${m.content}` }));
  chatHistory.push({ role: 'user', content: `@${usuario}: ${mensagem}` });
  // Exemplo de boas conversas para o prompt
  const exemplos = [
    { role: 'user', content: '@Joao: Qual o melhor horário para pagar um boleto?' },
    { role: 'assistant', content: 'Oi @Joao! O melhor horário é até as 17h em dias úteis, assim o pagamento compensa no mesmo dia.' },
    { role: 'user', content: '@Maria: O que é uma chave Pix aleatória?' },
    { role: 'assistant', content: 'Olá @Maria! Uma chave Pix aleatória é um código gerado pelo banco para receber pagamentos sem expor seus dados pessoais.' }
  ];
  try {
    const completion = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'Você é um bot simpático, prestativo e divertido em um servidor Discord brasileiro. Responda de forma breve, amigável, natural e relevante ao assunto. Sempre cite o usuário que te mencionou com @.' },
        ...exemplos,
        ...chatHistory
      ],
      max_tokens: 180,
      temperature: 0.6,
      n: 1
    });
    return completion.data.choices[0].message.content.trim();
  } catch (e) {
    console.error('Erro IA:', e.message);
    return null;
  }
}

client.once('ready', () => {
  console.log(`Bot online como ${client.user.tag}`);
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // IA: responde sempre que for mencionado (com contexto)
  if (message.mentions.users.has(client.user.id)) {
    // Troque para a função combinada
    const resposta = await iaResponderCombinada(message.content, message.author.username, message.channel);
    if (resposta) {
      message.reply(resposta);
    } else {
      message.reply('Desculpe, não consegui gerar uma resposta agora.');
    }
    return;
  }

  if (!message.content.startsWith('!')) {
    // Se o usuário está aguardando resposta para registro de chave Pix
    if (aguardandoRegistro[message.author.id]) {
      const estado = aguardandoRegistro[message.author.id];
      if (!estado.tipo) {
        const tipo = message.content.trim().toLowerCase();
        if (!['cpf', 'celular', 'email', 'aleatoria', 'cnpj'].includes(tipo)) {
          return message.reply('Tipo inválido. Responda com: cpf, celular, email, aleatoria ou cnpj.');
        }
        estado.tipo = tipo;
        saveRegistroStateMem();
        return message.reply(`Agora envie sua chave Pix do tipo ${tipo.toUpperCase()}:`);
      } else if (!estado.chave) {
        const chavePix = message.content.trim();
        let tipoDetectado = detectarTipoChavePix(chavePix);
        if ((estado.tipo === 'cpf' && tipoDetectado !== 'cpf') ||
            (estado.tipo === 'celular' && tipoDetectado !== 'cel') ||
            (estado.tipo === 'email' && tipoDetectado !== 'email') ||
            (estado.tipo === 'aleatoria' && tipoDetectado !== 'aleatoria') ||
            (estado.tipo === 'cnpj' && tipoDetectado !== 'cnpj')) {
          return message.reply(`A chave informada não corresponde ao tipo ${estado.tipo.toUpperCase()}. Tente novamente ou digite !pixreg para cancelar.`);
        }
        db[message.author.id] = { chave: chavePix, tipo: estado.tipo };
        saveDatabaseMem();
        delete aguardandoRegistro[message.author.id];
        saveRegistroStateMem();
        return message.reply(`Sua chave Pix (${estado.tipo.toUpperCase()}) foi registrada com sucesso!`);
      }
    }
    return;
  }

  const args = message.content.trim().split(' ');
  const command = args.shift().toLowerCase();
  const userId = message.author.id;

  // Comando para adicionar cargos permitidos
  if (command === '!pixadd') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('Apenas administradores podem adicionar cargos permitidos.');
    }
    const role = message.mentions.roles.first();
    if (!role) {
      return message.reply('Mencione o cargo que deseja permitir. Ex: !pixadd @cargo');
    }
    if (!allowedRoleIds.includes(role.id)) {
      allowedRoleIds.push(role.id);
    }
    saveDatabaseMem();
    return message.reply(`Cargo ${role.name} adicionado à lista de permissões do bot!`);
  }

  // Comando para remover cargos permitidos
  if (command === '!pixrem') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('Apenas administradores podem remover cargos permitidos.');
    }
    const role = message.mentions.roles.first();
    if (!role) {
      return message.reply('Mencione o cargo que deseja remover. Ex: !pixrem @cargo');
    }
    const index = allowedRoleIds.indexOf(role.id);
    if (index !== -1) {
      allowedRoleIds.splice(index, 1);
      saveDatabaseMem();
      return message.reply(`Cargo ${role.name} removido da lista de permissões do bot!`);
    } else {
      return message.reply(`O cargo ${role.name} não está na lista de permissões.`);
    }
  }

  // Permitir apenas administradores ou cargos permitidos
  if (message.guild) {
    const member = message.guild.members.cache.get(message.author.id);
    if (
      !member.permissions.has('Administrator') &&
      !member.roles.cache.some(role => allowedRoleIds.includes(role.id))
    ) {
      return message.reply('Você não tem permissão para usar este bot.');
    }
  }

  // Novo fluxo para registro interativo
  if (command === '!pixreg') {
    aguardandoRegistro[userId] = { tipo: null, chave: null };
    saveRegistroStateMem();
    return message.reply('Qual o tipo da sua chave Pix? Responda com: cpf, celular, email, aleatoria ou cnpj.');
  }

  if (command === '!pix') {
    try {
      if (args.length === 0) {
        const registro = db[userId];
        if (!registro || !registro.chave) {
          return message.reply('Você ainda não registrou sua chave Pix. Use `!pixreg` antes.\nExemplo de chave Pix: chave@exemplo.com');
        }
        const tipoChave = registro.tipo ? registro.tipo : detectarTipoChavePix(registro.chave || registro);
        return message.reply(`Chave Pix (${tipoChave.charAt(0).toUpperCase() + tipoChave.slice(1)}): ${registro.chave || registro}`);
      }
      const valor = parseFloat(args[0]);
      if (isNaN(valor) || valor <= 0) {
        return message.reply('Valor inválido. Use: `!pix valor` para gerar um QR Code');
      }
      const registro = db[userId];
      if (!registro || !registro.chave) {
        return message.reply('Você ainda não registrou sua chave Pix. Use `!pixreg` antes.\nExemplo de chave Pix: chave@exemplo.com');
      }
      const tipoChave = registro.tipo ? registro.tipo : detectarTipoChavePix(registro.chave || registro);
      const payload = gerarPayloadPix({
        key: registro.chave || registro,
        name: message.author.username || 'Usuário',
        city: 'BRASIL',
        value: valor
      });
      qrcode.toDataURL(payload, { width: 300 }, (err, url) => {
        if (err) {
          console.error('Erro ao gerar QR Code:', err);
          if (!message.hasReplied) return message.reply('Erro ao gerar QR Code.');
          return;
        }
        try {
          const buffer = Buffer.from(url.split(',')[1], 'base64');
          if (!message.hasReplied) return message.reply({
            content: `QR Code Pix para R$${valor.toFixed(2)} gerado com sucesso!\nChave Pix: ${registro.chave || registro}\nTipo de chave: ${tipoChave}`,
            files: [{ attachment: buffer, name: `pix-r${valor}.png` }]
          });
        } catch (e) {
          console.error('Erro ao enviar QR Code:', e);
          if (!message.hasReplied) return message.reply('Erro ao enviar QR Code.');
        }
      });
    } catch (e) {
      console.error('Erro inesperado no comando !pix:', e);
      message.reply('Erro inesperado ao processar o comando !pix.');
    }
  }

  if (command === '!pixver') {
    const mention = message.mentions.users.first();
    if (!mention) {
      return message.reply('Marque o usuário para ver a chave Pix dele. Ex: `!pixver @usuario`');
    }
    const registro = db[mention.id];
    if (!registro || !registro.chave) {
      return message.reply('Este usuário ainda não registrou uma chave Pix.');
    }
    const tipoChave = registro.tipo ? registro.tipo : detectarTipoChavePix(registro.chave || registro);
    return message.reply(`Chave Pix (${tipoChave}) de ${mention}: ${registro.chave || registro}`);
  }

  if (command === '!pixqrcode') {
    const mention = message.mentions.users.first();
    const valor = parseFloat(args[1]);
    if (!mention || isNaN(valor) || valor <= 0) {
      return message.reply('Use: !pixqrcode @usuario valor');
    }
    const registro = db[mention.id];
    if (!registro || !registro.chave) {
      return message.reply('Este usuário ainda não registrou uma chave Pix.');
    }
    const tipoChave = registro.tipo ? registro.tipo : detectarTipoChavePix(registro.chave || registro);
    const payload = gerarPayloadPix({
      key: registro.chave || registro,
      name: mention.username || 'Usuário',
      city: 'BRASIL',
      value: valor
    });
    qrcode.toDataURL(payload, { width: 300 }, (err, url) => {
      if (err) {
        console.error('Erro ao gerar QR Code:', err);
        return message.reply('Erro ao gerar QR Code.');
      }
      try {
        const buffer = Buffer.from(url.split(',')[1], 'base64');
        return message.reply({
          content: `QR Code Pix para R$${valor.toFixed(2)} de ${mention} gerado com sucesso!\nChave Pix (${tipoChave}): ${registro.chave || registro}`,
          files: [{ attachment: buffer, name: `pix-${mention.username}-r${valor}.png` }]
        });
      } catch (e) {
        console.error('Erro ao enviar QR Code:', e);
        return message.reply('Erro ao enviar QR Code.');
      }
    });
  }

  if (command === '!pixcmd') {
    return message.reply('!pixadd @cargo\n!pixrem @cargo\n!pixreg <chave>\n!pix\n!pix <valor>\n!pixver @usuario\n!pixqrcode @usuario <valor>\n!pixdel\n!pixlist\n!pixcopy\n!pixinfo\n!pixhelp\n!pixlog #canal');
  }

  if (command === '!pixlist') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('Apenas administradores podem ver todas as chaves Pix.');
    }
    const entries = Object.entries(db);
    if (entries.length === 0) {
      return message.reply('Nenhuma chave Pix registrada no servidor.');
    }
    let resposta = 'Chaves Pix registradas:\n';
    for (const [id, registro] of entries) {
      const user = await message.guild.members.fetch(id).catch(() => null);
      const nome = user ? user.user.tag : `ID: ${id}`;
      const tipoChave = registro.tipo ? registro.tipo : detectarTipoChavePix(registro.chave || registro);
      resposta += `- ${nome}: ${registro.chave || registro} (${tipoChave})\n`;
    }
    return message.reply(resposta);
  }

  if (command === '!pixdel') {
    if (!db[userId]) {
      return message.reply('Você não possui uma chave Pix registrada.');
    }
    delete db[userId];
    saveDatabaseMem();
    return message.reply('Sua chave Pix foi removida com sucesso!');
  }

  if (command === '!pixinfo') {
    return message.reply('Bot Pix para Discord. Permite registrar, consultar e gerar QR Code Pix. Use !pixcmd para ver todos os comandos.');
  }

  if (command === '!pixhelp') {
    return message.reply(
      '**Comandos disponíveis:**\n' +
      '!pixadd @cargo — Adiciona permissão para um cargo usar o bot\n' +
      '!pixrem @cargo — Remove permissão de um cargo\n' +
      '!pixreg <chave> — Registra sua chave Pix\n' +
      '!pix — Mostra sua chave Pix\n' +
      '!pix <valor> — Gera QR Code Pix para o valor\n' +
      '!pixver @usuario — Mostra a chave Pix de outro usuário\n' +
      '!pixqrcode @usuario <valor> — Gera QR Code Pix de outro usuário\n' +
      '!pixdel — Remove sua chave Pix\n' +
      '!pixlist — Lista todas as chaves Pix (admin)\n' +
      '!pixcopy — Envia o código Copia e Cola do Pix\n' +
      '!pixinfo — Informações sobre o bot\n' +
      '!pixhelp — Explica cada comando\n' +
      '!pixcmd — Lista todos os comandos\n' +
      '!pixlog #canal — Configura o canal de logs\n'
    );
  }

  if (command === '!pixcopy') {
    if (!db[userId]) {
      return message.reply('Você ainda não registrou sua chave Pix. Use !pixreg antes.');
    }
    if (args.length === 0) {
      return message.reply('Informe o valor. Ex: !pixcopy 10.50');
    }
    const valor = parseFloat(args[0]);
    if (isNaN(valor) || valor <= 0) {
      return message.reply('Valor inválido. Use: !pixcopy <valor>');
    }
    const registro = db[userId];
    const payload = gerarPayloadPix({
      key: registro.chave || registro,
      name: message.author.username || 'Usuário',
      city: 'BRASIL',
      value: valor
    });
    return message.reply(`Copia e Cola Pix para R$${valor.toFixed(2)}:\n\n${payload}`);
  }

  if (command === '!pixlog') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('Apenas administradores podem configurar o canal de logs.');
    }
    const canal = message.mentions.channels.first();
    if (!canal) {
      return message.reply('Mencione o canal de texto para logs. Ex: !pixlog #canal');
    }
    pixLogChannelId = canal.id;
    return message.reply(`Canal de logs definido para: ${canal}`);
  }
});

client.login(process.env.DISCORD_TOKEN);