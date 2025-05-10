require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits } = require('discord.js');
const qrcode = require('qrcode');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const DB_FILE = './database.json';

function loadDatabase() {
  if (!fs.existsSync(DB_FILE)) return {};
  return JSON.parse(fs.readFileSync(DB_FILE));
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

// Lista de IDs dos cargos permitidos a usar o bot
const allowedRoleIds = ['1368602269985275904']; // Substitua pelos IDs dos cargos desejados

client.once('ready', () => {
  console.log(`Bot online como ${client.user.tag}`);
});

client.on('messageCreate', message => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!')) return;

  // Verifica se o usuário tem algum dos cargos permitidos (por ID)
  if (message.guild) {
    const member = message.guild.members.cache.get(message.author.id);
    if (member && !member.roles.cache.some(role => allowedRoleIds.includes(role.id))) {
      return message.reply('Você não tem permissão para usar este bot.');
    }
  }

  const args = message.content.trim().split(' ');
  const command = args.shift().toLowerCase();

  const db = loadDatabase();
  const userId = message.author.id;

  if (command === '!pixreg') {
    const chavePix = args.join(' ');
    if (!chavePix) {
      return message.reply('Você precisa informar sua chave Pix. Ex: `!pixreg chave@exemplo.com`');
    }

    db[userId] = chavePix;
    saveDatabase(db);
    return message.reply('Sua chave Pix foi registrada com sucesso!');
  }

  if (command === '!pix') {
    try {
      if (args.length === 0) {
        const chave = db[userId];
        if (!chave) {
          return message.reply('Você ainda não registrou sua chave Pix. Use `!pixreg` antes.\nExemplo de chave Pix: chave@exemplo.com');
        }
        // Detecta o tipo de chave Pix
        let tipoChave = 'EVP';
        if (/^[0-9]{11}$/.test(chave)) tipoChave = 'CPF';
        else if (/^[0-9]{14}$/.test(chave)) tipoChave = 'CNPJ';
        else if (/^\+?\d{1,3}\d{10,11}$/.test(chave) || /^[1-9]{2}9?\d{8}$/.test(chave)) tipoChave = 'Celular';
        else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(chave)) tipoChave = 'E-mail';
        return message.reply(`Chave Pix (${tipoChave}): ${chave}`);
      }

      const valor = parseFloat(args[0]);
      if (isNaN(valor) || valor <= 0) {
        return message.reply('Valor inválido. Use: `!pix valor` para gerar um QR Code');
      }

      const chave = db[userId];
      if (!chave) {
        return message.reply('Você ainda não registrou sua chave Pix. Use `!pixreg` antes.\nExemplo de chave Pix: chave@exemplo.com');
      }

      // Gera payload Pix manualmente
      const payload = gerarPayloadPix({
        key: chave,
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
          // Detecta o tipo de chave Pix
          let tipoChave = 'EVP';
          if (/^[0-9]{11}$/.test(chave)) tipoChave = 'CPF';
          else if (/^[0-9]{14}$/.test(chave)) tipoChave = 'CNPJ';
          else if (/^\+?\d{1,3}\d{10,11}$/.test(chave) || /^[1-9]{2}9?\d{8}$/.test(chave)) tipoChave = 'Celular';
          else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(chave)) tipoChave = 'E-mail';
          // Envia a mensagem com QR, chave e modelo
          if (!message.hasReplied) return message.reply({
            content: `QR Code Pix para R$${valor.toFixed(2)} gerado com sucesso!\nChave Pix: ${chave}\nTipo de chave: ${tipoChave}`,
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
});

client.login(process.env.DISCORD_TOKEN);
