import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, Events } from "discord.js";
import dotenv from "dotenv";
import http from "http";
import mongoose from "mongoose";
dotenv.config();

// Disable mongoose buffering to prevent hanging
mongoose.set("bufferCommands", false);

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
  TICKET_TOOL_BOT_ID,
  MONGODB_URI,
  TRANSCRIPT_CHANNEL_ID
} = process.env;

const START_DELAY = 10 * 60 * 1000; // 10 min start after KING/Staff message
const REMINDER_INTERVAL = 6 * 60 * 60 * 1000; // 6h reminder
const STAFF_ALERT_TIME = 24 * 60 * 60 * 1000; // 24h staff alert

// === MONGODB SCHEMA ===
const ticketSchema = new mongoose.Schema({
  channelId: { type: String, required: true, unique: true },
  creatorId: { type: String, required: true },
  timerStartTime: { type: Number, default: null },
  reminderCount: { type: Number, default: 0 }
});

const Ticket = mongoose.model('Ticket', ticketSchema);

// In-memory timers (not stored in DB)
const timers = new Map();

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
    ),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Reset the current ticket (reminder count and timer)"),
  new SlashCommandBuilder()
    .setName("cleanup")
    .setDescription("Delete old tickets from database")
    .addIntegerOption(option =>
      option.setName("days")
        .setDescription("Delete tickets older than this many days")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(365)
    ),
  new SlashCommandBuilder()
    .setName("cleanup-all")
    .setDescription("Wipe all tickets from database (including deleted channels)")
].map(cmd => cmd.toJSON());

// --- LOG HELPER ---
function log(message, guild) {
  const channel = guild.channels.cache.get(LOG_CHANNEL_ID);
  if (channel) channel.send(message).catch(() => {});
}

// --- CLEAR TIMERS ---
function clearAllTimers(channelId) {
  const timer = timers.get(channelId);
  if (!timer) return;
  if (timer.start) clearTimeout(timer.start);
  if (timer.repeat) clearInterval(timer.repeat);
  if (timer.staff) clearTimeout(timer.staff);
  timers.delete(channelId);
}

// --- START TIMERS ---
async function startTimers(channel) {
  const channelId = channel.id;
  const ticket = await Ticket.findOne({ channelId });
  if (!ticket) return;

  // Clear any existing timers first
  clearAllTimers(channelId);

  const timer = {};
  timer.start = setTimeout(async () => {
    // Mark when timer actually started
    ticket.timerStartTime = Date.now();
    ticket.reminderCount = 0;
    await ticket.save();

    log(`⏱️ **Timer started** in ${channel}`, channel.guild);

    // Set up reminder interval (first reminder at 6 hours, then every 6 hours)
    timer.repeat = setInterval(() => {
      sendReminder(channel);
    }, REMINDER_INTERVAL);

    // Set up staff alert (24 hours from when timer started)
    timer.staff = setTimeout(() => {
      sendStaffAlert(channel);
    }, STAFF_ALERT_TIME);

  }, START_DELAY);

  timers.set(channelId, timer);
}

// --- SEND REMINDER ---
async function sendReminder(channel) {
  const ticket = await Ticket.findOne({ channelId: channel.id });
  if (!ticket) return;

  ticket.reminderCount = (ticket.reminderCount || 0) + 1;
  await ticket.save();

  // Stop sending reminders after 3
  if (ticket.reminderCount > 3) {
    const timer = timers.get(channel.id);
    if (timer?.repeat) {
      clearInterval(timer.repeat);
    }
    return;
  }

  // Different message for final reminder (3rd one)
  const isFinalReminder = ticket.reminderCount === 3;

  const embed = new EmbedBuilder()
    .setColor(isFinalReminder ? "Red" : "Yellow")
    .setTitle(isFinalReminder ? "🔔 Final Ticket Reminder ⚠️" : "🔔 Ticket Reminder")
    .setDescription(
      isFinalReminder 
        ? `<@${ticket.creatorId}>, please respond to this ticket immediately.\n\n• If you have any questions or need help, reply now\n• If your issue is solved, click the 🔒 button to close the ticket\n• ⚠️ This is your last chance - our team will close this ticket in 6 hours if you don't respond`
        : `<@${ticket.creatorId}>, please respond to this ticket.\n\n• If you have any questions or need help, reply here\n• If your issue is solved, click the 🔒 button to close the ticket\n• If we don't hear from you within 24 hours, our team may close this ticket`
    )
    .setFooter({ 
      text: isFinalReminder 
        ? "Reminder 3 of 3 • Final warning - 6 hours remaining" 
        : `Reminder ${ticket.reminderCount} of 3 • Next reminder in 6 hours` 
    })
    .setTimestamp();

  channel.send({ embeds: [embed] }).catch(() => {});
  log(`🔔 Reminder #${ticket.reminderCount} sent in ${channel}`, channel.guild);

  // After 3rd reminder, stop the interval
  if (ticket.reminderCount === 3) {
    const timer = timers.get(channel.id);
    if (timer?.repeat) {
      clearInterval(timer.repeat);
    }
  }
}

// --- SEND STAFF ALERT ---
async function sendStaffAlert(channel) {
  const ticket = await Ticket.findOne({ channelId: channel.id });
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
client.once(Events.ClientReady, async () => {
  try {
    console.log(`✅ Logged in as ${client.user.tag}`);

    // Load all tickets from MongoDB
    const tickets = await Ticket.find({});
    console.log(`✅ Loaded ${tickets.length} tickets from database`);

  // Restore active timers for tickets that had timers running
  for (const ticket of tickets) {
    if (ticket.timerStartTime) {
      const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
      if (channel) {
        const elapsed = Date.now() - ticket.timerStartTime;

        // If less than 24 hours elapsed, restore the timer
        if (elapsed < STAFF_ALERT_TIME) {
          const remainingTime = STAFF_ALERT_TIME - elapsed;

          // Calculate when next reminder should be
          const timeSinceLastReminder = elapsed % REMINDER_INTERVAL;
          const timeToNextReminder = REMINDER_INTERVAL - timeSinceLastReminder;

          const timer = {};

          // Set up next reminder
          timer.repeat = setInterval(() => {
            sendReminder(channel);
          }, REMINDER_INTERVAL);

          // Send reminder if it's time
          if (timeToNextReminder <= 1000) {
            sendReminder(channel);
          } else {
            setTimeout(() => {
              sendReminder(channel);
            }, timeToNextReminder);
          }

          // Set up staff alert for remaining time
          timer.staff = setTimeout(() => {
            sendStaffAlert(channel);
          }, remainingTime);

          timers.set(ticket.channelId, timer);

          console.log(`🔄 Restored timer for ticket ${ticket.channelId} (${Math.floor(elapsed / 60000)} minutes elapsed)`);
        } else {
          // Timer expired during downtime, send staff alert now
          sendStaffAlert(channel);
        }
      } else {
        // Channel doesn't exist anymore, clean up
        await Ticket.deleteOne({ channelId: ticket.channelId });
      }
    }
  }

  } catch (error) {
    console.error("❌ READY EVENT ERROR:", error);
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
  let ticket = await Ticket.findOne({ channelId: channel.id });

  if (!ticket) {
    let creatorId = null;

    // If message is from the ticket tool bot, find the first mentioned user (not staff/king)
    if (message.author.id === TICKET_TOOL_BOT_ID) {
      for (const [id, user] of message.mentions.users) {
        const mentionedMember = await message.guild.members.fetch(id).catch(() => null);
        if (mentionedMember) {
          const isMentionedStaff = mentionedMember.roles.cache.has(STAFF_ROLE_ID) || 
                                   mentionedMember.roles.cache.has(KING_ROLE_ID);
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
      ticket = await Ticket.create({
        channelId: channel.id,
        creatorId,
        timerStartTime: null,
        reminderCount: 0
      });
      log(`🎫 **Ticket creator stored:** <@${creatorId}> in ${channel}`, message.guild);
    }
    return;
  }

  // === CREATOR REPLY → STOP TIMERS ===
  if (!isStaff && message.author.id === ticket.creatorId) {
    const wasActive = ticket.timerStartTime !== null;
    clearAllTimers(channel.id);
    ticket.timerStartTime = null;
    ticket.reminderCount = 0;
    await ticket.save();
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

// --- TRANSCRIPT HANDLER (Send to Creator's DM) ---
client.on("messageCreate", async message => {
  console.log("🔍 TRANSCRIPT HANDLER v3 - Checking message..."); // Version identifier

  // Only process messages in transcript channel
  if (message.channel.id !== process.env.TRANSCRIPT_CHANNEL_ID) return;

  console.log("✅ Message detected in transcript channel");

  // Only process messages from Ticket Tool bot
  if (message.author.id !== "557628352828014614") {
    console.log(`❌ Message not from Ticket Tool bot (author: ${message.author.id})`);
    return;
  }

  console.log("✅ Message is from Ticket Tool bot");

  // Check if message has HTML attachment
  const htmlAttachment = message.attachments.find(att => att.name.endsWith('.html'));
  if (!htmlAttachment) {
    console.log("❌ No HTML attachment found");
    return;
  }

  console.log(`✅ HTML attachment found: ${htmlAttachment.name}`);

  try {
    // Extract creator ID from embed (Ticket Owner field)
    let creatorId = null;

    // Look for Ticket Owner in embed fields
    if (message.embeds && message.embeds.length > 0) {
      const embed = message.embeds[0];
      if (embed.fields) {
        for (const field of embed.fields) {
          if (field.name === "Ticket Owner") {
            // Extract user ID from mention: @MAAKTHUNDER or <@123456789>
            const userMatch = field.value.match(/<@!?(\d+)>|@(\w+)/);
            if (userMatch) {
              // If we found a mention with ID, use it
              if (userMatch[1]) {
                creatorId = userMatch[1];
                console.log(`✅ Found creator ID from mention: ${creatorId}`);
              } else {
                // If we found @username, we need to look it up
                console.log(`⚠️ Found username but no ID: ${userMatch[2]}`);
              }
            }
            break;
          }
        }
      }
    }

    // Fallback: try to find ticket in database by channel ID
    if (!creatorId) {
      console.log("⚠️ Could not find creator in embed, trying database lookup...");

      let ticketChannelId = null;

      // Try to find channel ID in message content (Server-Info block)
      if (message.content) {
        const contentMatch = message.content.match(/Channel:.*?\((\d{17,19})\)/);
        if (contentMatch) {
          ticketChannelId = contentMatch[1];
          console.log(`✅ Found channel ID in content: ${ticketChannelId}`);
        }
      }

      if (ticketChannelId) {
        console.log(`🔍 Looking up ticket in database: ${ticketChannelId}`);
        const ticket = await Ticket.findOne({ channelId: ticketChannelId });

        if (ticket && ticket.creatorId) {
          creatorId = ticket.creatorId;
          console.log(`✅ Found creator from database: ${creatorId}`);
        } else {
          console.log(`❌ No ticket found in database for channel ${ticketChannelId}`);
        }
      }
    }

    if (!creatorId) {
      console.log("❌ Could not find creator ID");
      return;
    }

    // Try to fetch the creator user
    const creator = await client.users.fetch(creatorId).catch(() => null);

    if (!creator) {
      console.log(`❌ Could not fetch user ${creatorId}`);
      return;
    }

    console.log(`✅ Creator fetched: ${creator.tag}`);

    // Download the HTML file
    console.log(`📥 Downloading transcript: ${htmlAttachment.url}`);
    const response = await fetch(htmlAttachment.url);
    const buffer = await response.arrayBuffer();
    console.log(`✅ Transcript downloaded (${buffer.byteLength} bytes)`);

    // Send DM to creator
    console.log(`📨 Sending DM to ${creator.tag}...`);
    await creator.send({
      content: `📋 **Your Ticket Transcript**\n\nYour support ticket has been closed. Here's your conversation transcript for your records.\n\n**📥 How to view:**\n• Download the HTML file attached below\n• Open it in your browser to see the full transcript\n\nThank you for contacting support!`,
      files: [{
        attachment: Buffer.from(buffer),
        name: htmlAttachment.name
      }]
    }).catch(err => {
      console.log(`⚠️ Could not send transcript to ${creator.tag}: ${err.message}`);
    });

    console.log(`✅ Transcript sent successfully to ${creator.tag} (${creatorId})`);
    log(`📋 **Transcript sent** to <@${creatorId}>`, message.guild);

  } catch (error) {
    console.error("❌ Error handling transcript:", error);
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
      flags: 64
    });
  }

  // === /TIMER COMMAND ===
  if (interaction.commandName === "timer") {
    const action = interaction.options.getString("action");
    const ticket = await Ticket.findOne({ channelId: channel.id });

    switch(action) {
      case "stop":
        if (!ticket || !ticket.timerStartTime) {
          return interaction.reply({ 
            content: "⏹️ No active timer to stop.", 
            flags: 64 
          });
        }
        clearAllTimers(channel.id);
        ticket.timerStartTime = null;
        ticket.reminderCount = 0;
        await ticket.save();
        await interaction.reply({ content: "⏹️ **Timer stopped immediately.**", flags: 64 });
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
        await ticket.save();

        const timer = {};

        // First reminder will come after 6 hours
        timer.repeat = setInterval(() => {
          sendReminder(channel);
        }, REMINDER_INTERVAL);

        // Staff alert after 24 hours
        timer.staff = setTimeout(() => {
          sendStaffAlert(channel);
        }, STAFF_ALERT_TIME);

        timers.set(channel.id, timer);

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
    const ticket = await Ticket.findOne({ channelId: channel.id });

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
      if (!ticket) {
        await Ticket.create({
          channelId: channel.id,
          creatorId: user.id,
          timerStartTime: null,
          reminderCount: 0
        });
      } else {
        ticket.creatorId = user.id;
        await ticket.save();
      }

      await interaction.reply({ 
        content: `✅ **Ticket creator manually assigned to** <@${user.id}>`, 
        flags: 64 
      });
      log(`✏️ **Ticket creator manually assigned** to <@${user.id}> in ${channel}`, channel.guild);
    }
  }

  // === /RESET COMMAND ===
  if (interaction.commandName === "reset") {
    const ticket = await Ticket.findOne({ channelId: channel.id });

    if (!ticket) {
      return interaction.reply({ 
        content: "❌ No ticket data found in this channel.", 
        flags: 64 
      });
    }

    // Clear all timers
    clearAllTimers(channel.id);

    // Reset ticket data
    ticket.reminderCount = 0;
    ticket.timerStartTime = null;
    await ticket.save();

    await interaction.reply({ 
      content: "🔄 **Ticket reset successfully!**\n\n• Reminder count: 0\n• Timer: Stopped\n• Creator: Unchanged\n\nStaff can now restart the timer.", 
      flags: 64 
    });

    log(`🔄 **Ticket reset** in ${channel}`, channel.guild);
  }

  // === /CLEANUP COMMAND ===
  if (interaction.commandName === "cleanup") {
    const days = interaction.options.getInteger("days");
    const cutoffDate = Date.now() - (days * 24 * 60 * 60 * 1000);

    // Find all tickets to check
    const allTickets = await Ticket.find({});
    let deletedCount = 0;
    const ticketsToDelete = [];

    for (const ticket of allTickets) {
      let shouldDelete = false;

      // Check if channel still exists
      const channelExists = await client.channels.fetch(ticket.channelId).catch(() => null);
      if (!channelExists) {
        shouldDelete = true;
        console.log(`🗑️ Channel ${ticket.channelId} no longer exists`);
      }
      // Check if timer is old
      else if (ticket.timerStartTime && ticket.timerStartTime < cutoffDate) {
        shouldDelete = true;
        console.log(`🗑️ Ticket ${ticket.channelId} timer older than ${days} days`);
      }

      if (shouldDelete) {
        ticketsToDelete.push(ticket.channelId);
      }
    }

    if (ticketsToDelete.length === 0) {
      return interaction.reply({ 
        content: `✅ **No cleanup needed!**\n\n• No tickets older than ${days} days\n• No deleted channels found\n• Database is clean`, 
        flags: 64 
      });
    }

    // Delete the tickets
    const result = await Ticket.deleteMany({
      channelId: { $in: ticketsToDelete }
    });

    await interaction.reply({ 
      content: `🗑️ **Cleanup complete!**\n\n• Deleted ${result.deletedCount} old tickets\n• Removed tickets from deleted channels\n• Database storage freed up`, 
      flags: 64 
    });

    log(`🗑️ **Cleanup:** Deleted ${result.deletedCount} tickets`, channel.guild);
  }

  // === /CLEANUP-ALL COMMAND ===
  if (interaction.commandName === "cleanup-all") {
    // Get total count before deleting
    const totalTickets = await Ticket.countDocuments();

    if (totalTickets === 0) {
      return interaction.reply({ 
        content: `✅ **Database is already empty!**\n\n• No tickets to clean up\n• Database is clean`, 
        flags: 64 
      });
    }

    // Delete ALL tickets - no checks, just wipe everything
    const result = await Ticket.deleteMany({});

    await interaction.reply({ 
      content: `🗑️ **Complete Database Wipe!**\n\n• Deleted **${result.deletedCount}** tickets\n• All ticket data removed\n• Database completely cleaned`, 
      flags: 64 
    });

    console.log(`🗑️ CLEANUP-ALL: Wiped entire database (${result.deletedCount} tickets)`);
    log(`🗑️ **Cleanup-All:** Wiped database - deleted ${result.deletedCount} tickets`, channel.guild);
  }
});

// === CHANNEL DELETE HANDLER (Clean up database) ===
client.on("channelDelete", async channel => {
  const ticket = await Ticket.findOne({ channelId: channel.id });
  if (ticket) {
    clearAllTimers(channel.id);
    await Ticket.deleteOne({ channelId: channel.id });
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

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI missing in .env file");
  process.exit(1);
}

// === CONNECT TO MONGODB FIRST ===
async function connectMongo() {
  try {
    mongoose.set("strictQuery", true);
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 15000
    });
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

await connectMongo();

client.login(DISCORD_BOT_TOKEN);

// Register slash commands after login (same pattern as MongoDB)
client.once(Events.ClientReady, async (readyClient) => {
  console.log("🔄 Registering slash commands...");
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
    await rest.put(
      Routes.applicationCommands(readyClient.user.id),
      { body: commands }
    );
    console.log("✅ Slash commands registered successfully!");
  } catch (error) {
    console.error("❌ Command registration error:", error);
  }
});

// === KEEP-ALIVE WEB SERVER FOR RENDER ===
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is alive! 🤖");
  } else if (req.url === "/status") {
    const ticketCount = await Ticket.countDocuments();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "online",
      tickets: ticketCount,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  } else if (req.url === "/test-db") {
    if (mongoose.connection.readyState !== 1) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        error: "MongoDB not connected",
        readyState: mongoose.connection.readyState
      }));
    }

    try {
      const ticketCount = await Ticket.countDocuments();
      const tickets = await Ticket.find().limit(5);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        mongooseState: "connected",
        ticketCount,
        tickets,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
  console.log(`📍 Use this URL in Uptime Robot: https://your-repl-name.your-username.repl.co`);
});
