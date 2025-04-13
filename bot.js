// bot.js
require('dotenv').config();
const {
    Client, GatewayIntentBits, Partials, PermissionsBitField, ChannelType,
    ActivityType, Events, GuildScheduledEventPrivacyLevel,
    GuildScheduledEventEntityType, GuildScheduledEventStatus,
    EmbedBuilder // Keep for potential future use
} = require('discord.js'); // Ensure PermissionsBitField and Events are imported
const cron = require('node-cron');
const { exec } = require('child_process');
const schedule = require('./schedule');

// --- Configuration from .env ---
const token = process.env.DISCORD_BOT_TOKEN;
const tvGuideChannelId = process.env.DISCORD_CHANNEL_ID;
const targetVoiceChannelId = process.env.TARGET_VOICE_CHANNEL_ID;
const ahkScriptPath1 = process.env.AHK_SCRIPT_PATH_1;
const COMMAND_PREFIX = '!';

// --- Constants ---
const DISCORD_MESSAGE_LIMIT = 2000;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000; // 14 days in milliseconds for bulk delete check

// --- Basic Validation ---
if (!token) { console.error("Missing DISCORD_BOT_TOKEN"); process.exit(1); }
if (!tvGuideChannelId) console.warn("Warning: DISCORD_CHANNEL_ID not set. Scheduled text posts disabled.");
if (!targetVoiceChannelId) console.warn("Warning: TARGET_VOICE_CHANNEL_ID not set. Scheduled Event updates disabled.");
if (!ahkScriptPath1) console.warn("Warning: AHK_SCRIPT_PATH_1 not set. !refresh script execution disabled.");

// --- Discord Client Setup ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildScheduledEvents,
        // GuildVoiceStates might NOT be needed anymore
    ],
});

// --- Global Variables ---
let tvGuideTargetChannel = null;
let targetVoiceChannel = null;
let managedGuildEvent = null;

// --- Helper: Format 24hr time string (HH:MM) to 12hr (h:mm AM/PM) ---
function formatTime12hr(timeString) {
    if (!timeString || !timeString.includes(':')) return timeString; // Return original if invalid
    const [hourStr, minuteStr] = timeString.split(':');
    let hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10); // Keep minutes as number for comparison if needed, format later

    if (isNaN(hour) || isNaN(minute)) return timeString; // Invalid format

    const ampm = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12;
    hour = hour ? hour : 12; // the hour '0' should be '12'

    const minutePadded = String(minute).padStart(2, '0'); // Pad minutes for display
    return `${hour}:${minutePadded} ${ampm}`;
}

// --- Helper: Format Message for TV Guide Posts (Scheduler ONLY) ---
function formatTvGuideMessage(showData) {
    if (!showData) return "Error: Schedule data missing.";
    if (showData.customMessage && typeof showData.customMessage === 'string') {
        return showData.customMessage; // Return custom message directly
    }
    if (!showData.now || !showData.next) {
        console.warn(`[${new Date().toLocaleString()}] formatTvGuideMessage: Invalid standard entry`, JSON.stringify(showData));
        return "Schedule information is currently unavailable.";
    }
    let message = `Now Playing: **${showData.now}**\nUp Next: **${showData.next}**`;
    if (showData.image && typeof showData.image === 'string' && showData.image.trim() !== '') {
        message += `\n${showData.image.trim()}`;
    }
    return message;
}

// --- Helper: Get Last Valid "Now Playing" Show Title ONLY (for Event Name) ---
// Renamed from getStageTopicTitle
function getCurrentShowTitle() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const todaysSchedule = schedule[dayOfWeek];
    if (!todaysSchedule) return null;
    const scheduledTimes = Object.keys(todaysSchedule).sort();
    let lastValidNowTitle = null;
    for (const time of scheduledTimes) {
        if (time > currentTimeStr) break;
        const showData = todaysSchedule[time];
        if (showData && showData.now && showData.next) { // Check for standard entry
            lastValidNowTitle = showData.now;
        }
    }
    return lastValidNowTitle ? lastValidNowTitle.replace(/\*+/g, '').trim() : null; // Remove markdown
}

// --- Helper: Find or Create the Managed Guild Scheduled Event ---
async function findOrCreateManagedEvent(guild) {
    if (!targetVoiceChannel) {
        console.error("[Event Manager] Target voice channel not available.");
        return null;
    }
    if (!guild) {
        console.error("[Event Manager] Guild object not available.");
        return null;
    }
    const botId = client.user.id;
    let foundEvent = null;

    try {
        // Fetch existing events in the guild
        const events = await guild.scheduledEvents.fetch();
        // Find an event created by this bot, linked to the target channel, and not completed/cancelled
        foundEvent = events.find(event =>
            event.creatorId === botId &&
            event.channelId === targetVoiceChannel.id &&
            event.status !== GuildScheduledEventStatus.Completed &&
            event.status !== GuildScheduledEventStatus.Canceled
        );

        if (foundEvent) {
            console.log(`[Event Manager] Found existing event: "${foundEvent.name}" (ID: ${foundEvent.id}, Status: ${GuildScheduledEventStatus[foundEvent.status]})`);
            // If it's scheduled but should be active (start time is past)
            if (foundEvent.status === GuildScheduledEventStatus.Scheduled && foundEvent.scheduledStartTimestamp < Date.now()) {
                console.log(`[Event Manager] Existing event is SCHEDULED but should be ACTIVE. Attempting to start...`);
                try {
                    foundEvent = await foundEvent.setStatus(GuildScheduledEventStatus.Active);
                    console.log(`[Event Manager] Event status set to ACTIVE.`);
                } catch(startError) {
                     console.error(`[Event Manager] Failed to set event status to ACTIVE:`, startError);
                     // Proceed with the found event anyway, update might fix it
                }
            }
            return foundEvent; // Return the found (and potentially started) event
        } else {
            console.log(`[Event Manager] No suitable existing event found. Creating new event...`);
            const initialName = getCurrentShowTitle() || "Stream Starting Soon"; // Default name
            const startTime = new Date(Date.now() + 5000); // Schedule 5 seconds from now to ensure it's in the future
            const endTime = new Date(startTime.getTime() + (4 * 60 * 60 * 1000)); // Schedule end time 4 hours after start (adjust as needed)

            const newEvent = await guild.scheduledEvents.create({
                name: initialName.substring(0, 100), // Max 100 chars for name
                scheduledStartTime: startTime,
                scheduledEndTime: endTime,
                privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
                entityType: GuildScheduledEventEntityType.Voice,
                channel: targetVoiceChannel.id, // Link to the voice channel
                description: "Live stream schedule event.", // Optional description
                // reason: "Creating managed event for live stream" // Optional audit log reason
            });
            console.log(`[Event Manager] Created new event "${newEvent.name}" (ID: ${newEvent.id}). Attempting to start immediately...`);
             // Although created slightly in the future, try setting to Active anyway.
             // Discord might handle this gracefully, or the next update cycle will catch it.
             try {
                  await newEvent.setStatus(GuildScheduledEventStatus.Active);
                  console.log(`[Event Manager] New event status set to ACTIVE.`);
                  return newEvent; // Return the activated event
             } catch(startError) {
                 console.warn(`[Event Manager] Could not immediately set new event status to ACTIVE (might be too soon):`, startError.message);
                 return newEvent; // Return the scheduled event, it will likely activate shortly
             }
        }
    } catch (error) {
        console.error(`[Event Manager] Error finding or creating event:`, error);
        if (error.code === 50013) console.error("   -> PERMISSION ERROR: Bot likely lacks 'Manage Events' permission in the server.");
        return null; // Failed
    }
}

// --- Helper: Update Managed Event Name ---
async function updateEventName(newName) {
    if (!managedGuildEvent) {
        console.warn(`[Event Update] Cannot update name: Managed event reference is missing. Trying to re-acquire...`);
        // Attempt to re-acquire the event if reference was lost
        const guild = client.guilds.cache.get(targetVoiceChannel?.guild?.id); // Get guild from channel cache
        managedGuildEvent = await findOrCreateManagedEvent(guild);
        if (!managedGuildEvent) {
             console.error(`[Event Update] Failed to re-acquire managed event. Update aborted.`);
             return false;
        }
         console.log(`[Event Update] Re-acquired managed event reference.`);
    }
     if (!newName || typeof newName !== 'string' || newName.trim() === '') {
        console.warn(`[Event Update] Attempted event name update with invalid name: "${newName}"`);
        return false;
    }

    // Ensure name isn't too long (Discord limit is 100 chars)
    const finalName = newName.trim().substring(0, 100);

    try {
         // Fetch the event again to ensure we have the latest state before editing
         const currentEventState = await managedGuildEvent.fetch(true);
         managedGuildEvent = currentEventState; // Update global reference

         // Check status before editing
         if(currentEventState.status === GuildScheduledEventStatus.Completed || currentEventState.status === GuildScheduledEventStatus.Canceled){
              console.warn(`[Event Update] Managed event (ID: ${currentEventState.id}) is COMPLETED or CANCELLED. Cannot update name. Will attempt recreation on next cycle.`);
              managedGuildEvent = null; // Clear reference so it gets recreated
              return false;
         }

        // Only edit if the name actually needs changing
        if (currentEventState.name !== finalName) {
            console.log(`[Event Update] Updating event name from "${currentEventState.name}" to "${finalName}" (ID: ${currentEventState.id})`);
            await currentEventState.edit({
                name: finalName,
                // reason: "Automatic schedule name update" // Optional audit log reason
            });
            console.log(`   -> Event name updated successfully.`);
        } else {
            console.log(`[Event Update] Event name "${finalName}" is already set. No update needed.`);
        }

        // Ensure it's active if possible (redundant check, but safe)
        if (currentEventState.status === GuildScheduledEventStatus.Scheduled && currentEventState.scheduledStartTimestamp < Date.now()) {
             console.log(`[Event Update] Event still SCHEDULED, attempting to set ACTIVE...`);
             await currentEventState.setStatus(GuildScheduledEventStatus.Active);
             console.log(`   -> Event status set to ACTIVE.`);
             managedGuildEvent = await currentEventState.fetch(true); // Refresh reference after status change
        }

        return true; // Success
    } catch (error) {
        console.error(`[Event Update] Error updating event name (ID: ${managedGuildEvent?.id}):`, error);
        if (error.code === 50013) console.error("   -> PERMISSION ERROR: Bot likely lacks 'Manage Events' permission.");
        if (error.code === 10062) console.error("   -> ERROR: Unknown Interaction (Often transient, or event was deleted).");
        if (error.code === 150006) console.error("   -> ERROR: Event has already started (usually ignorable if just setting name)."); // Might see this if trying to set status again

        // If the error indicates the event is gone, clear the reference
        if (error.code === 10062 || error.message.includes('Unknown Scheduled Event')) {
             console.warn(`[Event Update] Event seems to be gone. Clearing reference for recreation.`);
             managedGuildEvent = null;
        }
        return false; // Failure
    }
}

// --- Helper: Execute AHK Script ---
function runAhkScript(scriptPath, scriptName = 'script') {
    return new Promise((resolve, reject) => {
        if (!scriptPath) {
            const errMsg = `Path for ${scriptName} not configured in .env file.`;
            console.warn(`[${new Date().toLocaleString()}] Cannot run ${scriptName}: ${errMsg}`);
            return reject(new Error(errMsg));
        }
        const formattedPath = scriptPath.replace(/\//g, '\\');
        const command = `"${formattedPath}"`;
        console.log(`[${new Date().toLocaleString()}] Attempting to execute ${scriptName} via exec: ${command}`);
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`[${new Date().toLocaleString()}] !!! ERROR EXECUTING ${scriptName.toUpperCase()} (${formattedPath}) !!!`);
                console.error(`➡️ Exit Code: ${error.code}`);
                console.error(`➡️ Signal: ${error.signal}`);
                console.error(`➡️ Error Message: ${error.message}`);
                console.error(error.stack || error);
                if (stderr) {
                    console.error(`➡️ Stderr Output:\n${stderr}`);
                }
                console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
                return reject(error);
            }
            if (stderr) {
                console.warn(`[${new Date().toLocaleString()}] Stderr from ${scriptName} (${formattedPath}):\n${stderr}`);
            }
            console.log(`[${new Date().toLocaleString()}] Successfully executed ${scriptName} (${formattedPath}). Stdout:\n${stdout.trim() || '(No Stdout)'}`);
            resolve(stdout);
        });
    });
}

// --- Helper: Send potentially long message, splitting if necessary ---
async function sendSplitMessage(channel, content, prefix = '', suffix = '') {
    if (!channel || !content) return;
    const maxChunkLength = DISCORD_MESSAGE_LIMIT - prefix.length - suffix.length - 10; // Leave buffer for code blocks/newlines
    if (content.length <= DISCORD_MESSAGE_LIMIT) {
        await channel.send(prefix + content + suffix).catch(e => console.error("Error sending message chunk:", e));
    } else {
        console.log(`Message exceeds limit (${content.length}), attempting to split.`);
        let currentChunk = '';
        const lines = content.split('\n');
        for (const line of lines) {
            if (currentChunk.length + line.length + 1 <= maxChunkLength) { // +1 for newline
                currentChunk += line + '\n';
            } else {
                // Send the current chunk
                await channel.send(prefix + currentChunk + suffix).catch(e => console.error("Error sending message chunk:", e));
                // Start a new chunk with the current line
                currentChunk = line + '\n';
            }
        }
        // Send the last remaining chunk
        if (currentChunk.length > 0) {
            await channel.send(prefix + currentChunk + suffix).catch(e => console.error("Error sending message chunk:", e));
        }
         console.log(`Message split and sent.`);
    }
}

// --- Scheduling Logic (node-cron) ---
function setupCronJobs() {
    if (!tvGuideTargetChannel && !targetVoiceChannel) {
        console.log("Neither TV Guide post channel nor Event Voice channel are configured. No jobs scheduled.");
        return;
    }
    console.log("Setting up scheduled jobs...");
    let jobCount = 0;
    for (const dayOfWeek in schedule) {
        const daySchedule = schedule[dayOfWeek];
        for (const time in daySchedule) {
            const showDataForThisJob = { ...schedule[dayOfWeek][time] };
            const [hour, minute] = time.split(':');
            if (isNaN(parseInt(hour)) || isNaN(parseInt(minute))) continue;
            const cronPattern = `${minute} ${hour} * * ${dayOfWeek}`;
            try {
                cron.schedule(cronPattern, async () => { // Async callback
                    const timestamp = `[${new Date().toLocaleString()}] CRON Day ${dayOfWeek}@${time}`;
                    console.log(`${timestamp}: Job triggered.`);

                    // --- 1. Post TV Guide Text Message (if configured) ---
                    if (tvGuideTargetChannel) {
                        const messageToSend = formatTvGuideMessage(showDataForThisJob);
                        console.log(`${timestamp}: Formatting TV guide post...`);
                        try {
                            await tvGuideTargetChannel.send(messageToSend);
                            console.log(`${timestamp}: TV guide message sent to #${tvGuideTargetChannel.name}.`);
                        } catch (err) { console.error(`${timestamp}: ERROR sending TV guide message:`, err.message || err); }
                    }

                    // --- 2. Update Scheduled Event Name (if configured AND standard show) ---
                    if (targetVoiceChannel && showDataForThisJob.now && showDataForThisJob.next) {
                        const eventName = showDataForThisJob.now.replace(/\*+/g, '').trim(); // Get 'now' title
                        console.log(`${timestamp}: Formatting event name update... (Name: "${eventName}")`);
                        if (eventName) {
                            await updateEventName(eventName); // Call the new helper
                        } else {
                            console.warn(`${timestamp}: Extracted empty event name from standard entry. Skipping event update.`);
                        }
                    } else if (targetVoiceChannel) {
                        console.log(`${timestamp}: Schedule entry is custom or invalid. Skipping event name update.`);
                    }

                }, { scheduled: true, /* timezone: "America/New_York" */ });
                jobCount++;
            } catch (error) { console.error(`Error scheduling job for Day ${dayOfWeek} at ${time}:`, error); }
        }
    }
    console.log(`Scheduled ${jobCount} jobs.`);
}


// --- Bot Event Handlers ---
client.once(Events.ClientReady, async (readyClient) => {
    console.log(`\nLogged in as ${readyClient.user.tag}!`);
    client.user.setActivity('the TV Guide', { type: ActivityType.Watching });
    let guildForEvent = null; // Need guild context

    // Fetch TV Guide Channel (for text posts)
    if (tvGuideChannelId) {
        try {
            const channel = await readyClient.channels.fetch(tvGuideChannelId);
            if (channel && channel.isTextBased()) {
                tvGuideTargetChannel = channel;
                console.log(`-> TV Guide Post Channel OK: #${channel.name}`);
            } else { console.error(`-> TV Guide Post Channel Error: ID ${tvGuideChannelId} is not a valid text channel.`); }
        } catch (err) { console.error(`-> TV Guide Post Channel Error: Failed fetching ID ${tvGuideChannelId}: ${err.message}`); }
    }

    // Fetch Target Voice Channel (for event)
    if (targetVoiceChannelId) {
        try {
            const channel = await readyClient.channels.fetch(targetVoiceChannelId);
            if (channel && channel.type === ChannelType.GuildVoice) {
                 const perms = channel.permissionsFor(readyClient.user);
                 if (!perms?.has(PermissionsBitField.Flags.ViewChannel)) console.warn(`   -> Event Channel Warning: Missing View Channel permission for #${channel.name}`);
                 if (!perms?.has(PermissionsBitField.Flags.Connect)) console.warn(`   -> Event Channel Warning: Missing Connect permission for #${channel.name}`);
                targetVoiceChannel = channel;
                guildForEvent = channel.guild;
                console.log(`-> Event Voice Channel OK: #${channel.name}`);
                 const guildPerms = channel.guild.members.me?.permissions;
                  if (!guildPerms?.has(PermissionsBitField.Flags.ManageEvents)) {
                       console.error(`   -> FATAL ERROR: Bot lacks 'Manage Events' permission in the server "${channel.guild.name}". Event functionality disabled.`);
                       targetVoiceChannel = null;
                       guildForEvent = null;
                  } else {
                       console.log(`   -> 'Manage Events' permission confirmed.`);
                  }
            } else { console.error(`-> Event Voice Channel Error: ID ${targetVoiceChannelId} is not a valid Voice channel.`); }
        } catch (err) { console.error(`-> Event Voice Channel Error: Failed fetching ID ${targetVoiceChannelId}: ${err.message}`); }
    }

    // Find or Create the managed event AFTER fetching channels and confirming permissions
    if (targetVoiceChannel && guildForEvent) {
         console.log(`[Event Manager] Initializing event state...`);
         managedGuildEvent = await findOrCreateManagedEvent(guildForEvent);
         if (managedGuildEvent) {
              console.log(`[Event Manager] Initialization complete. Using event ID: ${managedGuildEvent.id}`);
              const initialTitle = getCurrentShowTitle();
              if(initialTitle) await updateEventName(initialTitle);
         } else {
              console.error(`[Event Manager] Initialization failed. Could not find or create the managed event.`);
         }
    }

    // Setup scheduled jobs AFTER fetching channels and initializing event
    setupCronJobs();

    console.log('--------------------------------------------------');
    console.log(`Bot Ready! Listening for commands prefixed with "${COMMAND_PREFIX}"`);
    console.log('--------------------------------------------------');
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild || !message.content.startsWith(COMMAND_PREFIX)) { return; }
    const args = message.content.slice(COMMAND_PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const timestamp = `[${new Date().toLocaleString()}] CMD ${command}`;

    // --- Command: !now ---
    if (command === 'now') {
         console.log(`${timestamp}: Received from ${message.author.tag} in #${message.channel.name}`);
         const getNowAndNextForCommand = () => {
            const now = new Date(); const dayOfWeek = now.getDay(); const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; const todaysSchedule = schedule[dayOfWeek]; if (!todaysSchedule) return null; const scheduledTimes = Object.keys(todaysSchedule).sort(); let lastValidData = null; for (const time of scheduledTimes) { if (time > currentTimeStr) break; const showData = todaysSchedule[time]; if (showData && showData.now && showData.next) { lastValidData = showData; } } return lastValidData;
         }
         const showData = getNowAndNextForCommand();
         let replyMessage = "Nothing seems to be scheduled right now.";
         if(showData){
            replyMessage = `Now Playing: **${showData.now}**\nUp Next: **${showData.next}**`;
             if (showData.image && typeof showData.image === 'string' && showData.image.trim() !== '') {
                 replyMessage += `\n${showData.image.trim()}`;
             }
         }
         await message.reply(replyMessage).catch(err => console.error(`${timestamp} Error replying to !now:`, err));
    }
    // --- Command: !refresh ---
    else if (command === 'refresh') {
         console.log(`${timestamp}: Received from ${message.author.tag} in #${message.channel.name}`);
         await message.reply("Attempting to refresh the stream event & trigger script!").catch(err => console.error(`${timestamp} Error sending initial reply:`, err));

        // 1. Update Event Name
        const currentEventName = getCurrentShowTitle(); // Get current show title
        let eventUpdateSuccess = false;
        if (currentEventName && targetVoiceChannel) { // Check if we have a name and channel
            console.log(`${timestamp}: Updating event name to "${currentEventName}"...`);
             await message.channel.send(`Updating event name to: "${currentEventName}"`).catch(err => console.error(`${timestamp} Error sending status:`, err));
            eventUpdateSuccess = await updateEventName(currentEventName); // Call the event update helper
        } else if (!targetVoiceChannel) {
             console.warn(`${timestamp}: Cannot update event - target channel not configured/available.`);
             await message.channel.send(`⚠️ Cannot update event: Channel not configured.`).catch(err => console.error(`${timestamp} Error sending status:`, err));
        } else {
             console.warn(`${timestamp}: Cannot update event - no current show title found.`);
              await message.channel.send(`⚠️ Cannot update event: No current show information found.`).catch(err => console.error(`${timestamp} Error sending status:`, err));
        }

        // 2. Run the AHK script
        let script1Success = false;
        try {
             console.log(`${timestamp}: Running refresh script...`);
             await message.channel.send(`⚙️ Executing refresh script...`).catch(err => console.error(`${timestamp} Error sending status:`, err));
            await runAhkScript(ahkScriptPath1, 'Refresh Script');
            script1Success = true;
             await message.channel.send(`✅ Refresh script executed.`).catch(err => console.error(`${timestamp} Error sending status:`, err));
        } catch (err) {
            console.error(`${timestamp}: Failed to execute refresh script. Error details should be logged above.`);
             await message.channel.send(`❌ Failed to execute refresh script. Check console logs.`).catch(err => console.error(`${timestamp} Error sending status:`, err));
        }

        // 3. Final Status Update
        await message.channel.send("🔄 Refresh sequence complete.").catch(err => console.error(`${timestamp} Error sending final status:`, err));
        console.log(`${timestamp}: Refresh sequence complete.`);
    }

    // --- Command: !day ---
    else if (command === 'day') {
        console.log(`${timestamp}: Received !day from ${message.author.tag} in #${message.channel.name}`);
        try {
            const today = new Date().getDay();
            const daySchedule = schedule[today];
            const dayName = DAY_NAMES[today];
            let scheduleOutput = `**Schedule for ${dayName}:**\n`;
            let entriesFound = 0;
            if (!daySchedule || Object.keys(daySchedule).length === 0) {
                scheduleOutput += "No schedule found for today.";
            } else {
                const times = Object.keys(daySchedule).sort();
                for (const time of times) {
                    const showData = daySchedule[time];
                    if (showData && showData.now) {
                        const formattedTime = formatTime12hr(time);
                        const title = showData.now.replace(/\*+/g, '').trim();
                        const line = `${formattedTime} - ${title}\n`;
                        scheduleOutput += line;
                        entriesFound++;
                    }
                }
                 if (entriesFound === 0) { scheduleOutput += "No specific shows listed for today."; }
            }
            await sendSplitMessage(message.channel, scheduleOutput, '```\n', '\n```');
        } catch (error) { console.error(`${timestamp}: Error handling !day command:`, error); await message.reply("Sorry, an error occurred while fetching today's schedule.").catch(e=>console.error("Error replying:", e)); }
    }

    // --- Command: !week ---
    else if (command === 'week') {
        console.log(`${timestamp}: Received !week from ${message.author.tag} in #${message.channel.name}`);
        try {
            let fullWeekOutput = '';
            let entriesFoundTotal = 0;
            // Process Mon-Sat first
            for (let dayIndex = 1; dayIndex <= 6; dayIndex++) {
                const daySchedule = schedule[dayIndex];
                const dayName = DAY_NAMES[dayIndex];
                let dayOutput = `**${dayName}**\n`;
                let entriesFoundThisDay = 0;
                if (daySchedule && Object.keys(daySchedule).length > 0) {
                    const times = Object.keys(daySchedule).sort();
                    for (const time of times) {
                        const showData = daySchedule[time];
                        if (showData && showData.now) {
                            const formattedTime = formatTime12hr(time);
                            const title = showData.now.replace(/\*+/g, '').trim();
                            dayOutput += `${formattedTime} - ${title}\n`;
                            entriesFoundThisDay++;
                        }
                    }
                }
                if (entriesFoundThisDay > 0) { fullWeekOutput += dayOutput + '\n'; entriesFoundTotal++; }
            }
            // Process Sunday last
             const sundayIndex = 0; const sundaySchedule = schedule[sundayIndex]; const sundayName = DAY_NAMES[sundayIndex]; let sundayOutput = `**${sundayName}**\n`; let entriesFoundSunday = 0; if (sundaySchedule && Object.keys(sundaySchedule).length > 0) { const times = Object.keys(sundaySchedule).sort(); for (const time of times) { const showData = sundaySchedule[time]; if (showData && showData.now) { const formattedTime = formatTime12hr(time); const title = showData.now.replace(/\*+/g, '').trim(); sundayOutput += `${formattedTime} - ${title}\n`; entriesFoundSunday++; } } } if (entriesFoundSunday > 0) { fullWeekOutput += sundayOutput + '\n'; entriesFoundTotal++; }

            if (entriesFoundTotal === 0) { await message.reply("No schedule found for the entire week.").catch(e=>console.error("Error replying:", e)); } else { await sendSplitMessage(message.channel, fullWeekOutput, '```\n--- Weekly Schedule ---\n\n', '\n```'); }
        } catch (error) { console.error(`${timestamp}: Error handling !week command:`, error); await message.reply("Sorry, an error occurred while fetching the weekly schedule.").catch(e=>console.error("Error replying:", e)); }
    }

    // --- Command: !movies ---
    else if (command === 'movies') {
        console.log(`${timestamp}: Received !movies from ${message.author.tag} in #${message.channel.name}`);
        try {
            let movieListOutput = '';
            let moviesFound = 0;
            const moviePrefix = "MOVIE:";
            // Process Mon-Sat first
            for (let dayIndex = 1; dayIndex <= 6; dayIndex++) {
                const daySchedule = schedule[dayIndex]; if (!daySchedule) continue; const times = Object.keys(daySchedule).sort(); for (const time of times) { const showData = daySchedule[time]; if (showData && showData.now && showData.now.trim().toUpperCase().startsWith(moviePrefix)) { const dayName = DAY_NAMES[dayIndex]; const formattedTime = formatTime12hr(time); const movieTitle = showData.now.trim().substring(moviePrefix.length).trim(); movieListOutput += `${dayName}, ${formattedTime} - ${movieTitle}\n`; moviesFound++; } }
            }
            // Process Sunday last
            const sundayIndex = 0; const sundaySchedule = schedule[sundayIndex]; if (sundaySchedule) { const times = Object.keys(sundaySchedule).sort(); for (const time of times) { const showData = sundaySchedule[time]; if (showData && showData.now && showData.now.trim().toUpperCase().startsWith(moviePrefix)) { const dayName = DAY_NAMES[sundayIndex]; const formattedTime = formatTime12hr(time); const movieTitle = showData.now.trim().substring(moviePrefix.length).trim(); movieListOutput += `${dayName}, ${formattedTime} - ${movieTitle}\n`; moviesFound++; } } }

            if (moviesFound === 0) { await message.reply("No entries marked with 'MOVIE:' found in the schedule.").catch(e=>console.error("Error replying:", e)); } else { await sendSplitMessage(message.channel, movieListOutput, '```\n--- Movie Listings ---\n\n', '\n```'); }
        } catch (error) { console.error(`${timestamp}: Error handling !movies command:`, error); await message.reply("Sorry, an error occurred while fetching the movie list.").catch(e=>console.error("Error replying:", e)); }
    }

    // --- Command: !clear ---
    else if (command === 'clear') {
        console.log(`${timestamp}: Received !clear from ${message.author.tag} in #${message.channel.name}`);
        // 1. Authorization Check (User Permissions)
        if (!message.member?.permissions.has(PermissionsBitField.Flags.ManageMessages)) { console.warn(`${timestamp}: Denied !clear from ${message.author.tag} - User lacks Manage Messages permission.`); await message.reply("You need the 'Manage Messages' permission to use this command.").catch(e => console.error("Error replying:", e)); return; }
        // 2. Bot Permission Check
        const botPermissions = message.guild.members.me?.permissionsIn(message.channel); if (!botPermissions?.has(PermissionsBitField.Flags.ManageMessages)) { console.error(`${timestamp}: Failed !clear - Bot lacks Manage Messages permission in #${message.channel.name}.`); await message.reply("I don't have the 'Manage Messages' permission in this channel to delete messages.").catch(e => console.error("Error replying:", e)); return; } if (!botPermissions?.has(PermissionsBitField.Flags.ReadMessageHistory)) { console.error(`${timestamp}: Failed !clear - Bot lacks Read Message History permission in #${message.channel.name}.`); await message.reply("I don't have the 'Read Message History' permission in this channel, which I need to find messages to delete.").catch(e => console.error("Error replying:", e)); return; }
        // 3. Calculate Time Threshold
        const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
        // 4. Fetch Messages
        let messagesToDelete; let replyMsg = null; try { replyMsg = await message.reply(`🧹 Fetching my messages from the last 12 hours...`).catch(e => {console.error("Error sending initial reply:", e); return null;}); console.log(`${timestamp}: Fetching messages in #${message.channel.name}...`); const fetchedMessages = await message.channel.messages.fetch({ limit: 100 });
            // 5. Filter Messages
            messagesToDelete = fetchedMessages.filter(msg => msg.author.id === client.user.id && msg.createdTimestamp > twelveHoursAgo && (Date.now() - msg.createdTimestamp) < FOURTEEN_DAYS_MS);
            console.log(`${timestamp}: Found ${messagesToDelete.size} messages to delete.`);
            if (messagesToDelete.size === 0) { if(replyMsg) await replyMsg.edit("🧹 No messages from me found in the last 12 hours to delete.").catch(e => console.error("Error editing reply:", e)); else await message.channel.send("🧹 No messages from me found in the last 12 hours to delete.").catch(e => console.error("Error replying:", e)); return; }
            // 6. Bulk Delete
            console.log(`${timestamp}: Attempting to bulk delete ${messagesToDelete.size} messages...`); const deletedMessages = await message.channel.bulkDelete(messagesToDelete, true); const confirmationText = `✅ Successfully deleted ${deletedMessages.size} message(s).`; console.log(`${timestamp}: ${confirmationText}`);
            // 7. Send Confirmation & Cleanup
             if(replyMsg) await replyMsg.edit(confirmationText).catch(e => console.error("Error editing reply:", e)); else await message.channel.send(confirmationText).catch(e => console.error("Error sending reply:", e));
        } catch (error) { console.error(`${timestamp}: Error during !clear operation:`, error); const errorText = "❌ An error occurred while trying to delete messages."; if(replyMsg) await replyMsg.edit(errorText).catch(e => console.error("Error editing reply:", e)); else await message.channel.send(errorText).catch(e => console.error("Error replying:", e)); if (error.code === 50034) { console.error("   -> Note: Attempted to delete messages older than 14 days."); } }
    }


}); // End of messageCreate

// --- Error Handling & Login ---
client.on('error', error => console.error(`[${new Date().toLocaleString()}] Discord Client Error:`, error));
client.on('warn', warning => console.warn(`[${new Date().toLocaleString()}] Discord Client Warning:`, warning));
process.on('SIGINT', () => { console.log("SIGINT received, shutting down..."); client.destroy(); process.exit(0); });
process.on('SIGTERM', () => { console.log("SIGTERM received, shutting down..."); client.destroy(); process.exit(0); });

console.log("Attempting to log in...");
client.login(token).catch(loginError => {
    console.error("!!!!!!!!!!!!!!!! LOGIN FAILED !!!!!!!!!!!!!!!!");
    console.error(loginError);
    process.exit(1);
});
