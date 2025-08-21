const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@adiwajshing/baileys");
const pino = require("pino");
const fs = require("fs");

// Settings path
const SETTINGS_PATH = "./settings.json";

// Initialize settings if they don't exist
if (!fs.existsSync(SETTINGS_PATH)) {
  const defaultSettings = {
    "superSu": "2347045889973@s.whatsapp.net",
    "admins": [],
    "bannedWords": ["scam", "spam", "http://", "https://", "www."],
    "welcomeMessage": "👋 Welcome @user to the group! Please read the rules with !rules",
    "goodbyeMessage": "👋 @user has left the group",
    "rules": `📜 GROUP RULES

⚡ Respect is non-negotiable – No insults, hate speech, or personal attacks.
⚡ Active participation – If you're inactive for 2 weeks, admins may remove you.
⚡ Spam = Red Card – Don't flood with stickers, forwards, or random links.
⚡ Stay in theme during games – Side talk only after games are done.
⚡ Privacy first – No leaking group chats or personal details. Pictures in one-time view.
⚡ Admin final say – Admins anchor games and moderate disputes.`,
    "features": {
      "antiLinks": true,
      "antiSpam": true,
      "bannedWords": true,
      "welcomeMessages": true,
      "goodbyeMessages": true,
      "inactivityCheck": true
    },
    "warnings": {},
    "cooldowns": {
      "tagAll": {},
      "spam": {}
    },
    "userActivity": {}
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSettings, null, 2));
}

// Load settings
let settings = JSON.parse(fs.readFileSync(SETTINGS_PATH));

// Save settings function
function saveSettings() {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// Check if user is admin
function isAdmin(user) {
  return user === settings.superSu || settings.admins.includes(user);
}

// Warn user function
function warnUser(user) {
  const now = Date.now();
  if (!settings.warnings[user]) settings.warnings[user] = [];
  settings.warnings[user].push(now);

  // Keep only warnings from the last 24 hours
  settings.warnings[user] = settings.warnings[user].filter(
    t => now - t < 24 * 60 * 60 * 1000
  );

  const count = settings.warnings[user].length;
  saveSettings();
  return count;
}

// Check cooldown function
function checkCooldown(feature, identifier, cooldownTime) {
  const now = Date.now();
  if (!settings.cooldowns[feature]) settings.cooldowns[feature] = {};
  
  if (settings.cooldowns[feature][identifier] && 
      now - settings.cooldowns[feature][identifier] < cooldownTime) {
    return Math.ceil((cooldownTime - (now - settings.cooldowns[feature][identifier])) / 1000);
  }
  
  settings.cooldowns[feature][identifier] = now;
  saveSettings();
  return 0;
}

// Update user activity
function updateUserActivity(user, group) {
  const now = Date.now();
  if (!settings.userActivity[group]) settings.userActivity[group] = {};
  settings.userActivity[group][user] = now;
  saveSettings();
}

// Check for inactive users
function checkInactiveUsers(group) {
  if (!settings.userActivity[group]) return [];
  
  const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
  const inactiveUsers = [];
  
  for (const [user, lastActive] of Object.entries(settings.userActivity[group])) {
    if (lastActive < twoWeeksAgo) {
      inactiveUsers.push(user);
    }
  }
  
  return inactiveUsers;
}

// Main bot function
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session");
  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m.message || !m.key.remoteJid) return;

    const from = m.key.remoteJid;
    const isGroup = from.endsWith("@g.us");
    if (!isGroup) return;

    const sender = m.key.participant || m.key.remoteJid;
    const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
    const userName = m.pushName || sender.split("@")[0];
    
    if (!text) return;

    // Update user activity
    updateUserActivity(sender, from);

    // Reload settings
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH));

    // --- Anti-Spam Protection ---
    if (settings.features.antiSpam) {
      const spamCooldown = checkCooldown("spam", sender, 2000); // 2 seconds between messages
      if (spamCooldown > 0) {
        await sock.sendMessage(from, { 
          text: `⏰ @${userName}, please wait before sending another message.` 
        }, { mentions: [sender] });
        return;
      }
    }

    // --- Auto Moderation ---
    if (settings.features.bannedWords) {
      for (const word of settings.bannedWords) {
        if (text.toLowerCase().includes(word.toLowerCase())) {
          const count = warnUser(sender);
          await sock.sendMessage(from, { 
            text: `⚠️ @${userName} used a banned word. Warnings: ${count}` 
          }, { mentions: [sender] });

          if (count >= 5) {
            await sock.groupParticipantsUpdate(from, [sender], "remove");
            await sock.sendMessage(from, { 
              text: `🚫 @${userName} was removed for excessive warnings.` 
            }, { mentions: [sender] });
          } else if (count >= 3) {
            await sock.sendMessage(from, { 
              text: `🤐 @${userName} has been muted for repeated violations.` 
            }, { mentions: [sender] });
          }
          return;
        }
      }
    }

    if (settings.features.antiLinks && (text.includes("http") || text.includes("www."))) {
      const count = warnUser(sender);
      await sock.sendMessage(from, { 
        text: `🚫 @${userName}, links are not allowed. Warning ${count}` 
      }, { mentions: [sender] });
      
      // Delete the message with link
      await sock.sendMessage(from, { 
        delete: m.key 
      });
      
      if (count >= 3) {
        await sock.groupParticipantsUpdate(from, [sender], "remove");
        await sock.sendMessage(from, { 
          text: `🚫 @${userName} was removed for sharing links.` 
        }, { mentions: [sender] });
      }
      return;
    }

    // --- Command Handling ---
    if (text.startsWith("!")) {
      // Ignore commands from non-admins except for !rules and !help
      if (!isAdmin(sender) && !["!rules", "!help"].includes(text.split(" ")[0].toLowerCase())) {
        return;
      }

      const args = text.trim().split(/\s+/);
      const cmd = args[0].toLowerCase();

      // Reply target (for reply-based commands)
      const replyTarget = m.message.extendedTextMessage?.contextInfo?.participant;

      // Help command
      if (cmd === "!help") {
        let helpText = "🤖 *Bot Commands*\n\n";
        
        if (sender === settings.superSu) {
          helpText += "*SuperSU Commands:*\n";
          helpText += "!addadmin [reply to user] - Add admin\n";
          helpText += "!deladmin [reply to user] - Remove admin\n";
          helpText += "!addword [word] - Add banned word\n";
          helpText += "!delword [word] - Remove banned word\n";
          helpText += "!toggle [feature] - Toggle feature\n";
          helpText += "!setwelcome [message] - Set welcome message\n";
          helpText += "!setgoodbye [message] - Set goodbye message\n";
          helpText += "!setrules [rules] - Set group rules\n";
          helpText += "!checkinactive - Check inactive users\n";
          helpText += "!cleaninactive - Remove inactive users\n\n";
        }
        
        if (isAdmin(sender)) {
          helpText += "*Admin Commands:*\n";
          helpText += "!admins - List admins\n";
          helpText += "!bannedwords - List banned words\n";
          helpText += "!warn [reply to user] - Warn user\n";
          helpText += "!kick [reply to user] - Kick user\n";
          helpText += "!tagall [message] - Mention all members\n";
          helpText += "!mute [time] - Mute group (e.g., !mute 1h)\n";
          helpText += "!unmute - Unmute group\n";
          helpText += "!settings - Show settings\n";
        }
        
        helpText += "*Member Commands:*\n";
        helpText += "!rules - Show group rules\n";
        helpText += "!help - Show this help\n\n";
        helpText += "*Features Status:*\n";
        helpText += `Anti-Links: ${settings.features.antiLinks ? "✅" : "❌"}\n`;
        helpText += `Anti-Spam: ${settings.features.antiSpam ? "✅" : "❌"}\n`;
        helpText += `Banned Words: ${settings.features.bannedWords ? "✅" : "❌"}\n`;
        helpText += `Welcome Messages: ${settings.features.welcomeMessages ? "✅" : "❌"}\n`;
        helpText += `Goodbye Messages: ${settings.features.goodbyeMessages ? "✅" : "❌"}\n`;
        helpText += `Inactivity Check: ${settings.features.inactivityCheck ? "✅" : "❌"}\n`;

        await sock.sendMessage(from, { text: helpText });
        return;
      }

      // SuperSU-only commands
      if (sender === settings.superSu) {
        if (cmd === "!addadmin" && replyTarget) {
          if (!settings.admins.includes(replyTarget)) {
            settings.admins.push(replyTarget);
            saveSettings();
            await sock.sendMessage(from, { 
              text: `✅ Added @${replyTarget.split("@")[0]} as admin.` 
            }, { mentions: [replyTarget] });
          }
          return;
        }
        
        if (cmd === "!deladmin" && replyTarget) {
          settings.admins = settings.admins.filter(a => a !== replyTarget);
          saveSettings();
          await sock.sendMessage(from, { 
            text: `❌ Removed @${replyTarget.split("@")[0]} from admins.` 
          }, { mentions: [replyTarget] });
          return;
        }
        
        if (cmd === "!addword" && args[1]) {
          if (!settings.bannedWords.includes(args[1])) {
            settings.bannedWords.push(args[1]);
            saveSettings();
            await sock.sendMessage(from, { text: `➕ Added banned word: ${args[1]}` });
          }
          return;
        }
        
        if (cmd === "!delword" && args[1]) {
          settings.bannedWords = settings.bannedWords.filter(w => w !== args[1]);
          saveSettings();
          await sock.sendMessage(from, { text: `➖ Removed banned word: ${args[1]}` });
          return;
        }
        
        if (cmd === "!toggle" && args[1]) {
          if (settings.features[args[1]] !== undefined) {
            settings.features[args[1]] = !settings.features[args[1]];
            saveSettings();
            await sock.sendMessage(from, { 
              text: `🔀 Feature ${args[1]} set to ${settings.features[args[1]]}` 
            });
          } else {
            await sock.sendMessage(from, { 
              text: `⚠️ Unknown feature. Available: ${Object.keys(settings.features).join(", ")}` 
            });
          }
          return;
        }
        
        if (cmd === "!setwelcome" && args.length > 1) {
          const welcomeMsg = text.substring(11); // Remove "!setwelcome "
          settings.welcomeMessage = welcomeMsg;
          saveSettings();
          await sock.sendMessage(from, { text: "✅ Welcome message updated" });
          return;
        }
        
        if (cmd === "!setgoodbye" && args.length > 1) {
          const goodbyeMsg = text.substring(11); // Remove "!setgoodbye "
          settings.goodbyeMessage = goodbyeMsg;
          saveSettings();
          await sock.sendMessage(from, { text: "✅ Goodbye message updated" });
          return;
        }
        
        if (cmd === "!setrules" && args.length > 1) {
          const rules = text.substring(9); // Remove "!setrules "
          settings.rules = rules;
          saveSettings();
          await sock.sendMessage(from, { text: "✅ Group rules updated" });
          return;
        }
        
        if (cmd === "!checkinactive") {
          const inactiveUsers = checkInactiveUsers(from);
          if (inactiveUsers.length === 0) {
            await sock.sendMessage(from, { text: "✅ No inactive users found (2+ weeks inactive)" });
          } else {
            await sock.sendMessage(from, { 
              text: `⏰ Inactive users (2+ weeks):\n${inactiveUsers.map(u => `@${u.split("@")[0]}`).join("\n")}`,
              mentions: inactiveUsers
            });
          }
          return;
        }
        
        if (cmd === "!cleaninactive") {
          const inactiveUsers = checkInactiveUsers(from);
          if (inactiveUsers.length === 0) {
            await sock.sendMessage(from, { text: "✅ No inactive users to remove" });
          } else {
            await sock.groupParticipantsUpdate(from, inactiveUsers, "remove");
            await sock.sendMessage(from, { 
              text: `🧹 Removed ${inactiveUsers.length} inactive users:\n${inactiveUsers.map(u => `@${u.split("@")[0]}`).join("\n")}`,
              mentions: inactiveUsers
            });
          }
          return;
        }
      }

      // Admin commands
      if (isAdmin(sender)) {
        if (cmd === "!admins") {
          const adminList = settings.admins.map(a => `@${a.split("@")[0]}`).join("\n") || "No additional admins";
          await sock.sendMessage(from, { 
            text: `👮 Admins:\n- @${settings.superSu.split("@")[0]} (SuperSU)\n${adminList}` 
          }, { mentions: [settings.superSu, ...settings.admins] });
          return;
        }
        
        if (cmd === "!bannedwords") {
          await sock.sendMessage(from, { 
            text: `🚫 Banned Words:\n${settings.bannedWords.join(", ") || "None"}` 
          });
          return;
        }
        
        if (cmd === "!warn" && replyTarget) {
          const count = warnUser(replyTarget);
          await sock.sendMessage(from, { 
            text: `⚠️ Warned @${replyTarget.split("@")[0]} (${count} warnings)` 
          }, { mentions: [replyTarget] });
          
          if (count >= 3) {
            await sock.groupParticipantsUpdate(from, [replyTarget], "remove");
            await sock.sendMessage(from, { 
              text: `🚫 @${replyTarget.split("@")[0]} was removed for exceeding warnings` 
            }, { mentions: [replyTarget] });
          }
          return;
        }
        
        if (cmd === "!kick" && replyTarget) {
          await sock.groupParticipantsUpdate(from, [replyTarget], "remove");
          await sock.sendMessage(from, { 
            text: `👢 @${replyTarget.split("@")[0]} was kicked from the group` 
          }, { mentions: [replyTarget] });
          return;
        }
        
        if (cmd === "!tagall") {
          // Check cooldown (24 hours)
          const cooldownLeft = checkCooldown("tagAll", from, 24 * 60 * 60 * 1000);
          if (cooldownLeft > 0) {
            const hours = Math.floor(cooldownLeft / 3600);
            const minutes = Math.floor((cooldownLeft % 3600) / 60);
            await sock.sendMessage(from, { 
              text: `⏰ TagAll is on cooldown. Try again in ${hours}h ${minutes}m` 
            });
            return;
          }
          
          const groupMetadata = await sock.groupMetadata(from);
          const participants = groupMetadata.participants;
          const mentions = participants.map(p => p.id);
          const message = args.slice(1).join(" ") || "📢 Attention everyone!";
          
          await sock.sendMessage(from, { 
            text: `${message}\n\n${mentions.map(m => `@${m.split("@")[0]}`).join(" ")}`, 
            mentions 
          });
          return;
        }
        
        if (cmd === "!mute") {
          let duration = 60 * 60 * 1000; // Default 1 hour
          if (args[1]) {
            const time = parseInt(args[1]);
            const unit = args[1].replace(time, "").toLowerCase();
            
            if (unit.includes("h")) duration = time * 60 * 60 * 1000;
            else if (unit.includes("m")) duration = time * 60 * 1000;
            else if (unit.includes("d")) duration = time * 24 * 60 * 60 * 1000;
            else duration = time * 60 * 1000; // Default to minutes
          }
          
          await sock.groupSettingUpdate(from, "announcement");
          await sock.sendMessage(from, { 
            text: `🔇 Group muted for ${Math.floor(duration / 60000)} minutes` 
          });
          
          // Auto-unmute after duration
          setTimeout(async () => {
            await sock.groupSettingUpdate(from, "not_announcement");
            await sock.sendMessage(from, { text: "🔊 Group unmuted" });
          }, duration);
          return;
        }
        
        if (cmd === "!unmute") {
          await sock.groupSettingUpdate(from, "not_announcement");
          await sock.sendMessage(from, { text: "🔊 Group unmuted" });
          return;
        }
        
        if (cmd === "!settings") {
          await sock.sendMessage(from, { 
            text: `⚙️ Current Settings:\n${JSON.stringify(settings, null, 2)}` 
          });
          return;
        }
      }
      
      // Member commands
      if (cmd === "!rules") {
        await sock.sendMessage(from, { text: settings.rules });
        return;
      }
    }
  });

  // Handle group participants update (welcome/goodbye messages)
  sock.ev.on("group-participants.update", async (update) => {
    const { id, participants, action } = update;
    
    if (settings.features.welcomeMessages && action === "add") {
      for (const user of participants) {
        const welcomeMsg = settings.welcomeMessage.replace("@user", `@${user.split("@")[0]}`);
        await sock.sendMessage(id, { 
          text: welcomeMsg, 
          mentions: [user] 
        });
      }
    }
    
    if (settings.features.goodbyeMessages && action === "remove") {
      for (const user of participants) {
        const goodbyeMsg = settings.goodbyeMessage.replace("@user", `@${user.split("@")[0]}`);
        await sock.sendMessage(id, { 
          text: goodbyeMsg, 
          mentions: [user] 
        });
      }
    }
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        startBot();
      }
    } else if (connection === "open") {
      console.log("✅ Bot connected to WhatsApp");
    }
  });
}

startBot();