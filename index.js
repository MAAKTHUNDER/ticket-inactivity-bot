const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TOKEN = "YOUR_BOT_TOKEN";
const TICKET_CATEGORY_ID = "123456789012345678"; // Ticket Tool category
const STAFF_ROLE_ID = "123456789012345678";     // Support staff role

// Store ticket timers
const tickets = new Map();

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  const channel = message.channel;

  // Only ticket channels
  if (channel.parentId !== 1434571556121743411) return;

  const isStaff = message.member.roles.cache.has(STAFF_ROLE_ID);

  // If USER replies → reset timers
  if (!isStaff) {
    tickets.delete(channel.id);
    return;
  }

  // Staff replied → start timers
  if (isStaff) {
    if (tickets.has(channel.id)) return;

    const reminder = setTimeout(() => {
      channel.send(
        "🔔 **Reminder:** We haven’t received a response yet.\n" +
        "Please confirm if your issue is resolved, otherwise this ticket will auto-close."
      );
    }, 6 * 60 * 60 * 1000); // 6 hours

    const autoclose = setTimeout(async () => {
      try {
        await channel.send("🔒 **Ticket closed due to inactivity.**");
        await channel.delete();
      } catch (e) {}
    }, 24 * 60 * 60 * 1000); // 24 hours

    tickets.set(channel.id, { reminder, autoclose });
  }
});

client.login(TOKEN);
