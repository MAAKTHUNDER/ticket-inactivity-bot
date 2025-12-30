import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import http from "http";
dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const {
  DISCORD_BOT_TOKEN,
  TICKET_CATEGORY_ID,
  STAFF_ROLE_ID,
  KING_ROLE_ID,
  LOG_CHANNEL_ID,
  TICKET_TOOL_BOT_ID
} = process.env;

const START_DELAY = 10 * 60 * 1000; // 10 min start after KING/Staff message
const REMINDER_INTERVAL = 6 * 60 * 60 * 1000; // 6h reminder
const STAFF_ALERT_TIME = 24 * 60 * 60 * 1000; // 24h staff alert
const STORAGE_FILE = "./ticket-data.json"; // Persistent storage file

const tickets = new Map();

// --- PERSISTENT STORAGE FUNCTIONS ---
function saveTickets() {
  try {
    const data = {};
    for (const [channelId, ticket] of tickets.entries()) {
      // Only save essential data, not timers (they'll be recreated)
      data[channelId] = {
        creatorId: ticket.creatorId,
        timerStartTime: ticket.timerStartTime,
        reminderCount: ticket.reminderCount || 0
      };
    }
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("❌ Error saving tickets:", error);
  }
}

function loadTickets() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf8"));
      for (const [channelId, ticketData] of Object.entries(data)) {
        tickets.set(channelId, {
          creatorId: ticketData.creatorId,
          timers: {},
          timerStartTime: ticketData.timerStartTime || null,
          reminderCount: ticketData.reminderCount || 0
        });
      }
      console.log(`✅ Loaded ${tickets.size} tickets from storage`);
    }
  } catch (error) {
    console.error("❌ Error loading tickets:", error);
  }
}

// --- SLASH COMMANDS ---
const commands = [
  new SlashCommandBuilder()
    .setName("timer")
    .setDescription("Manage ticket timers")
    .addStringOption(option =>
      option.setName("action")
        .setDescription("stop/restart/status")
        .setRequired(true)
        .addChoices(
          { name: "stop", value: "stop" },
          { name: "restart", value: "restart" },
          { name: "status", value: "status" }
        )
    ),
  new SlashCommandBuilder()
    .setName("creator")
    .setDescription("Check or assign the ticket creator")
    .addStringOption(option =>
      option.setName("action")
        .setDescription("check/assign")
        .setRequired(true)
        .addChoices(
          { name: "check", value: "check" },
          { name: "assign", value: "assign" }
        )
    )
    .addUserOption(option =>
      option.setName("user")
        .setDescription("User to assign as ticket creator (required for assign)")
    )
].map(cmd => cmd.toJSON());

// --- LOG HELPER ---
function log(message, guild) {
  const channel = guild.channels.cache.get(LOG_CHANNEL_ID);
  if (channel) channel.send(message).catch(() => {});
}

// --- CLEAR TIMERS ---
function clearAllTimers(channelId) {
  const ticket = tickets.get(channelId);
  if (!ticket) return;
  if (ticket.timers.start) clearTimeout(ticket.timers.start);
  if (ticket.timers.repeat) clearInterval(ticket.timers.repeat);
  if (ticket.timers.staff) clearTimeout(ticket.timers.staff);
  ticket.timers = {};
  ticket.timerStartTime = null;
  ticket.reminderCount = 0;
  saveTickets(); // Save cleared state
}

// --- START TIMERS ---
function startTimers(channel) {
  const channelId = channel.id;
  const ticket = tickets.get(channelId);
  if (!ticket) return;

  // Clear any existing timers first
  clearAllTimers(channelId);

  ticket.timers.start = setTimeout(() => {
    // Mark when timer actually started
    ticket.timerStartTime = Date.now();
    ticket.reminderCount = 0;
    
    saveTickets(); // Save timer start time
    log(`⏱️ **Timer started** in ${channel}`, channel.guild);

    // Set up reminder interval (first reminder at 6 hours, then every 6 hours)
    ticket.timers.repeat = setInterval(() => {
      sendReminder(channel);
    }, REMINDER_INTERVAL);

    // Set up staff alert (24 hours from when timer started)
    ticket.timers.staff = setTimeout(() => {
      sendStaffAlert(channel);
    }, STAFF_ALERT_TIME);

  }, START_DELAY);
}

// --- SEND REMINDER ---
function sendReminder(channel) {
  const ticket = tickets.get(channel.id);
  if (!ticket) return;
  
  ticket.reminderCount = (ticket.reminderCount || 0) + 1;
  saveTickets(); // Save reminder count
  
  const embed = new EmbedBuilder()
    .setColor("Yellow")
    .setTitle("🔔 Ticket Reminder")
    .setDescription(`<@${ticket.creatorId}>, please reply to this ticket.\n\n⚠️ **Warning:** Staff may close this ticket after 24 hours if there's no response.`)
    .setFooter({ text: `Reminder #${ticket.reminderCount} • Automatic reminder every 6 hours` })
    .setTimestamp();
  
  channel.send({ embeds: [embed] }).catch(() => {});
  log(`🔔 Reminder #${ticket.reminderCount} sent in ${channel}`, channel.guild);
}

// --- SEND STAFF ALERT ---
function sendStaffAlert(channel) {
  const ticket = tickets.get(channel.id);
  const embed = new EmbedBuilder()
    .setColor("Red")
    .setTitle("⏰ 24-Hour Inactivity Alert")
    .setDescription(`<@&${STAFF_ROLE_ID}> <@&${KING_ROLE_ID}>\n\n🚨 **No response from ticket creator** <@${ticket?.creatorId}> **for 24 hours.**\n\nPlease **close and delete** this ticket manually.`)
    .setFooter({ text: "Ticket has been inactive for 24 hours" })
    .setTimestamp();
  
  channel.send({ embeds: [embed] }).catch(() => {});
  log(`⚠️ **24-hour staff alert** sent for ${channel}`, channel.guild);
}

// --- GET TIME ELAPSED ---
function getTimeElapsed(startTime) {
  if (!startTime) return "Timer not started";
  
  const elapsed = Date.now() - startTime;
  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  const minutes = Math.floor((elapsed % (60 * 60 * 1000)) / (60 * 1000));
  
  return `${hours}h ${minutes}m`;
}

// --- READY EVENT ---
client.once("clientready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Load saved tickets from file
  loadTickets();

  // Restore active timers for tickets that had timers running
  for (const [channelId, ticket] of tickets.entries()) {
    if (ticket.timerStartTime) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel) {
        const elapsed = Date.now() - ticket.timerStartTime;
        
        // If less than 24 hours elapsed, restore the timer
        if (elapsed < STAFF_ALERT_TIME) {
          const remainingTime = STAFF_ALERT_TIME - elapsed;
          
          // Calculate when next reminder should be
          const timeSinceLastReminder = elapsed % REMINDER_INTERVAL;
          const timeToNextReminder = REMINDER_INTERVAL - timeSinceLastReminder;
          
          // Set up next reminder
          ticket.timers.repeat = setInterval(() => {
            sendReminder(channel);
          }, REMINDER_INTERVAL);
          
          // Send reminder if it's time
          if (timeToNextReminder <= 1000) {
            sendReminder(channel);
          } else {
            setTimeout(() => {
              sendReminder(channel);
              // Then continue with regular interval
            }, timeToNextReminder);
          }
          
          // Set up staff alert for remaining time
          ticket.timers.staff = setTimeout(() => {
            sendStaffAlert(channel);
          }, remainingTime);
          
          console.log(`🔄 Restored timer for ticket ${channelId} (${Math.floor(elapsed / 60000)} minutes elapsed)`);
        } else {
          // Timer expired during downtime, send staff alert now
          sendStaffAlert(channel);
        }
      } else {
        // Channel doesn't exist anymore, clean up
        tickets.delete(channelId);
      }
    }
  }
  
  saveTickets(); // Save after cleanup

  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log("✅ Global slash commands registered. May take up to 1 hour to appear.");
  } catch (error) {
    console.error("❌ Error registering commands:", error);
  }
});

// --- MESSAGE HANDLER ---
client.on("messageCreate", async message => {
  if (!message.guild) return;
  if (message.author.bot && message.author.id !== TICKET_TOOL_BOT_ID) return;
  
  const channel = message.channel;
  if (channel.parentId !== TICKET_CATEGORY_ID) return;

  const member = message.member;
  const isStaff = member?.roles.cache.has(STAFF_ROLE_ID) || member?.roles.cache.has(KING_ROLE_ID);

  // === TICKET CREATOR DETECTION (Only once when ticket is created) ===
  if (!tickets.has(channel.id)) {
    let creatorId = null;

    // If message is from the ticket tool bot, find the first mentioned user (not staff/king)
    if (message.author.id === TICKET_TOOL_BOT_ID) {
      for (const [id, user] of message.mentions.users) {
        const mentionedMember = await message.guild.members.fetch(id).catch(() => null);
        if (mentionedMember) {
          const isMentionedStaff = mentionedMember.roles.cache.has(STAFF_ROLE_ID) || 
                                   mentionedMember.roles.cache.has(KING_ROLE_ID);
          // Skip if it's a role mention or staff member
          if (!isMentionedStaff && !user.bot) {
            creatorId = id;
            break;
          }
        }
      }
    } 
    // If first message is from a regular user (not staff), they are the creator
    else if (!isStaff && !message.author.bot) {
      creatorId = message.author.id;
    }

    if (creatorId) {
      tickets.set(channel.id, { 
        creatorId, 
        timers: {}, 
        timerStartTime: null,
        reminderCount: 0
      });
      saveTickets(); // Save to file
      log(`🎫 **Ticket creator stored:** <@${creatorId}> in ${channel}`, message.guild);
    }
    return;
  }

  const ticket = tickets.get(channel.id);

  // === CREATOR REPLY → STOP TIMERS ===
  if (!isStaff && message.author.id === ticket.creatorId) {
    const wasActive = ticket.timerStartTime !== null;
    clearAllTimers(channel.id);
    if (wasActive) {
      log(`🛑 **Timer stopped** (creator replied) in ${channel}`, message.guild);
    }
    return;
  }

  // === STAFF/KING MESSAGE → RESTART TIMERS ===
  if (isStaff) {
    clearAllTimers(channel.id);
    startTimers(channel);
  }
});

// --- SLASH COMMAND HANDLER ---
client.on("interactionCreate", async interaction => {
  if (!interaction.isCommand()) return;
  
  const channel = interaction.channel;
  const member = interaction.member;
  const isStaff = member.roles.cache.has(STAFF_ROLE_ID) || member.roles.cache.has(KING_ROLE_ID);
  
  if (!isStaff) {
    return interaction.reply({ 
      content: "❌ You are not authorized to use this command.", 
      flags: 64 // MessageFlags.Ephemeral
    });
  }

  // === /TIMER COMMAND ===
  if (interaction.commandName === "timer") {
    const action = interaction.options.getString("action");
    const ticket = tickets.get(channel.id);

    switch(action) {
      case "stop":
        if (!ticket || !ticket.timerStartTime) {
          return interaction.reply({ 
            content: "⏹️ No active timer to stop.", 
            flags: 64 
          });
        }
        clearAllTimers(channel.id);
        await interaction.reply({ 
          content: "⏹️ **Timer stopped immediately.**", 
          flags: 64 
        });
        log(`⏹️ **Timer manually stopped** in ${channel}`, channel.guild);
        break;

      case "restart":
        if (!ticket) {
          return interaction.reply({ 
            content: "❌ No ticket data found. Please assign a creator first.", 
            flags: 64 
          });
        }
        clearAllTimers(channel.id);
        
        // Restart timer immediately without 10min delay and WITHOUT sending reminder
        ticket.timerStartTime = Date.now();
        ticket.reminderCount = 0;
        
        saveTickets(); // Save restarted state
        
        // First reminder will come after 6 hours
        ticket.timers.repeat = setInterval(() => {
          sendReminder(channel);
        }, REMINDER_INTERVAL);
        
        // Staff alert after 24 hours
        ticket.timers.staff = setTimeout(() => {
          sendStaffAlert(channel);
        }, STAFF_ALERT_TIME);
        
        await interaction.reply({ 
          content: "🔄 **Timer restarted immediately.** First reminder will be sent in 6 hours.", 
          flags: 64 
        });
        log(`🔄 **Timer manually restarted** in ${channel}`, channel.guild);
        break;

      case "status":
        if (!ticket) {
          return interaction.reply({ 
            content: "❌ No ticket data found.", 
            flags: 64 
          });
        }
        
        if (!ticket.timerStartTime) {
          return interaction.reply({ 
            content: "⏱️ **Timer Status:** Inactive\n\n❌ Timer is not currently running.", 
            flags: 64 
          });
        }
        
        const elapsed = getTimeElapsed(ticket.timerStartTime);
        const embed = new EmbedBuilder()
          .setColor("Blue")
          .setTitle("⏱️ Timer Status")
          .setDescription(`**Status:** ✅ Active\n**Time Elapsed:** ${elapsed}\n**Reminders Sent:** ${ticket.reminderCount}\n**Creator:** <@${ticket.creatorId}>`)
          .setFooter({ text: "Staff alert will trigger at 24 hours" })
          .setTimestamp();
        
        await interaction.reply({ embeds: [embed], flags: 64 });
        break;
    }
  }

  // === /CREATOR COMMAND ===
  if (interaction.commandName === "creator") {
    const action = interaction.options.getString("action");
    const ticket = tickets.get(channel.id);

    if (action === "check") {
      if (!ticket) {
        return interaction.reply({ 
          content: "❌ No creator assigned yet.", 
          flags: 64 
        });
      }
      
      const embed = new EmbedBuilder()
        .setColor("Green")
        .setTitle("🎫 Ticket Creator")
        .setDescription(`**Creator:** <@${ticket.creatorId}>\n**User ID:** ${ticket.creatorId}`)
        .setFooter({ text: "Use /creator assign to change if incorrect" })
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], flags: 64 });
      
    } else if (action === "assign") {
      const user = interaction.options.getUser("user");
      
      if (!user) {
        return interaction.reply({ 
          content: "❌ You must provide a user to assign.", 
          flags: 64 
        });
      }
      
      // Create or update ticket creator
      if (!tickets.has(channel.id)) {
        tickets.set(channel.id, { 
          creatorId: user.id, 
          timers: {}, 
          timerStartTime: null,
          reminderCount: 0
        });
      } else {
        tickets.get(channel.id).creatorId = user.id;
      }
      
      saveTickets(); // Save assigned creator
      
      await interaction.reply({ 
        content: `✅ **Ticket creator manually assigned to** <@${user.id}>`, 
        flags: 64 
      });
      log(`✏️ **Ticket creator manually assigned** to <@${user.id}> in ${channel}`, channel.guild);
    }
  }
});

// === CHANNEL DELETE HANDLER (Clean up memory) ===
client.on("channelDelete", channel => {
  if (tickets.has(channel.id)) {
    clearAllTimers(channel.id);
    tickets.delete(channel.id);
    saveTickets(); // Save after deletion
    console.log(`🗑️ Cleaned up ticket data for deleted channel ${channel.id}`);
  }
});

// --- LOGIN ---
if (!DISCORD_BOT_TOKEN) {
  console.error("❌ DISCORD_BOT_TOKEN missing in .env file");
  process.exit(1);
}

// Validate environment variables
if (!TICKET_CATEGORY_ID || !STAFF_ROLE_ID || !KING_ROLE_ID || !LOG_CHANNEL_ID || !TICKET_TOOL_BOT_ID) {
  console.error("❌ Missing required environment variables. Please check your .env file.");
  process.exit(1);
}

client.login(DISCORD_BOT_TOKEN);

// === KEEP-ALIVE WEB SERVER FOR REPLIT ===
// This creates a simple web server that Uptime Robot can ping to keep your bot running 24/7
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is alive! 🤖");
  } else if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "online",
      tickets: tickets.size,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
  console.log(`📍 Use this URL in Uptime Robot: https://your-repl-name.your-username.repl.co`);
});
