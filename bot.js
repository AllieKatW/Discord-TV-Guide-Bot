// =============================================================================
// === bot.js ===
// Description: A Discord bot designed to manage a scheduled "TV channel" stream,
//              allowing users to switch to a "Custom Channel" mode for playing
//              local files or YouTube videos. It interacts with external AHK
//              scripts for stream control, uses yt-dlp for downloads, manages
//              Discord Scheduled Events, and provides interactive commands.
// Features:
// - Scheduled stream management via `schedule.js` and `node-cron`.
// - Custom Channel mode with timed prompts and VLC title detection (Windows-only).
// - Interactive remote control via Discord Buttons (`!remote`).
// - YouTube video/playlist download queue (`!youtube`, `yt-dlp-exec`).
// - File browsing interface for downloaded content (`!browse`).
// - Polls for switching modes (`!custom`, `!ptv`) and skipping items (`!skip`).
// - Integration with AutoHotkey scripts (.ahk) for external actions.
// - Discord Scheduled Event management corresponding to the current mode/show.
// =============================================================================

// --- Environment Variables and Dependencies ---
require('dotenv').config(); // Load environment variables from .env file
const {
    // Core Discord classes
    Client, GatewayIntentBits, Partials, Events, Collection,
    // Permissions and Channel Types
    PermissionsBitField, ChannelType,
    // Activity and Scheduled Events
    ActivityType, GuildScheduledEventPrivacyLevel, GuildScheduledEventEntityType, GuildScheduledEventStatus,
    // Embeds and Components (Buttons, Modals)
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, ModalBuilder,
    // Input Components
    TextInputBuilder, TextInputStyle,
    // Interaction Types
    InteractionType
} = require('discord.js');
const cron = require('node-cron'); // For scheduling tasks (TV Guide posts)
const { exec } = require('child_process'); // For executing external scripts (AHK)
const ytDlpExec = require('yt-dlp-exec'); // Wrapper for executing yt-dlp
const fs = require('fs'); // Standard file system module
const fsp = require('fs').promises; // Promises-based file system module
const path = require('path'); // For handling file paths
const schedule = require('./schedule'); // Load the stream schedule configuration

// --- Configuration from .env ---
// These variables MUST be defined in a '.env' file in the same directory.
const token = process.env.DISCORD_BOT_TOKEN; // Discord Bot Token (Required)
const tvGuideChannelId = process.env.DISCORD_CHANNEL_ID; // Channel ID for schedule text posts
const targetVoiceChannelId = process.env.TARGET_VOICE_CHANNEL_ID; // Voice channel for Scheduled Events
const videoDownloadFolder = process.env.VIDEO_DOWNLOAD_FOLDER; // Root folder for YouTube downloads and browsing
const refreshAhkPath = process.env.REFRESH_AHK_SCRIPT_PATH; // AHK script for refreshing scheduled stream
const customAhkPathTo = process.env.CUSTOM_AHK_SCRIPT_PATH_TO; // AHK script to switch TO custom mode
const customAhkPathBack = process.env.CUSTOM_AHK_SCRIPT_PATH_BACK; // AHK script to switch BACK FROM custom mode
const customRefreshAhkPath = process.env.CUSTOM_REFRESH_AHK_SCRIPT_PATH; // AHK script to refresh during custom mode
const skipCustomAhkPath = process.env.SKIP_CUSTOM_AHK_SCRIPT_PATH; // AHK script to skip item in custom mode
const openFileAhkPath = process.env.OPEN_FILE_AHK_PATH; // AHK script to open a selected file (used by !browse)
const ytDlpPath = process.env.YT_DLP_PATH; // Optional: Path to yt-dlp executable
const ffmpegPath = process.env.FFMPEG_PATH; // Optional: Path to ffmpeg executable (needed for re-encoding)
const fileManagementUrl = process.env.FILE_MANAGEMENT_URL; // Optional: URL for users to manage downloaded files (e.g., Google Drive link)
const COMMAND_PREFIX = '!'; // Prefix for bot commands

// --- Constants ---
// General
const DISCORD_MESSAGE_LIMIT = 2000; // Max characters per Discord message
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]; // For schedule display
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000; // Used for Discord bulk message deletion limit (messages older than 14 days cannot be bulk deleted)
const EPHEMERAL_CONTENT_LIMIT = 2000; // Limit for ephemeral messages (may be lower in practice, but 2000 is API max)
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm']; // Allowed video extensions for !browse
// Regex to match invalid Windows path characters and prevent traversal ("..", leading/trailing dots)
const INVALID_PATH_CHARS_REGEX = /[<>:"/\\|?*\x00-\x1f]|\.\.|\.$|^\./g;

// Timeouts (Milliseconds)
const CUSTOM_MODE_DURATION_MS = 2 * 60 * 60 * 1000; // Duration before "Still Watching?" prompt in custom mode (2 hours)
const STILL_WATCHING_TIMEOUT_MS = 5 * 60 * 1000; // Timeout for the "Still Watching?" prompt (5 minutes)
const REMOTE_TIMEOUT_MS = 60 * 1000; // Timeout for the !remote interactive message (1 minute)
const REMOTE_SCHEDULE_CHOICE_TIMEOUT_MS = 30 * 1000; // Timeout for schedule view buttons (30 seconds)
const CUSTOM_POLL_TIMEOUT_MS = 60 * 1000; // Timeout for !custom/!ptv mode switch polls (1 minute)
const SKIP_POLL_TIMEOUT_MS = 30 * 1000; // Base timeout for !skip polls (30 seconds)
const SKIP_VOTE_COOLDOWN_MS = 60 * 1000; // Cooldown between !skip vote attempts (1 minute)
const MIN_SKIP_POLL_DURATION_MS = 5000; // Minimum duration for a skip poll (5 seconds)
const SKIP_POLL_DECREMENT_MS = 5000; // Amount to decrease skip poll duration per consecutive skip (5 seconds)
const BROWSE_TIMEOUT_MS = 5 * 60 * 1000; // Timeout for the entire !browse session (5 minutes)
const BROWSE_NUMBER_INPUT_TIMEOUT_MS = 30 * 1000; // Timeout for typing item number in !browse (30 seconds)
const BROWSE_SEARCH_INPUT_TIMEOUT_MS = 60 * 1000; // Timeout for typing search query in !browse (1 minute)
const BROWSE_SELECT_POLL_TIMEOUT_MS = 60 * 1000; // Timeout for the file selection confirmation poll in !browse (1 minute)
const VLC_TITLE_CHECK_INTERVAL_MS = 60 * 1000; // How often to check VLC title in custom mode (1 minute)

// YouTube Download Settings
const YT_DOWNLOAD_ETA_UPDATE_INTERVAL_MS = 60 * 1000; // How often to update download progress message (1 minute)
const PLAYLIST_VIDEO_LIMIT = 50; // Max videos to queue from a single playlist URL

// Browse Settings
const BROWSE_ITEMS_PER_PAGE = 10; // Number of items to show per page in !browse

// --- Basic Configuration Validation ---
// Checks essential configurations on startup and warns/exits if necessary.
if (!token) { console.error("FATAL ERROR: Missing DISCORD_BOT_TOKEN in .env file. Bot cannot log in."); process.exit(1); }
if (!tvGuideChannelId) console.warn("Warning: DISCORD_CHANNEL_ID not set. Scheduled text posts disabled.");
if (!targetVoiceChannelId) console.warn("Warning: TARGET_VOICE_CHANNEL_ID not set. Discord Scheduled Event updates disabled.");
if (!refreshAhkPath) console.warn("Warning: REFRESH_AHK_SCRIPT_PATH not set. Standard 'Refresh' button/!refresh function disabled.");
if (!customAhkPathTo) console.warn("Warning: CUSTOM_AHK_SCRIPT_PATH_TO not set. 'Switch to Custom' button/!custom command disabled.");
if (!customAhkPathBack) console.warn("Warning: CUSTOM_AHK_SCRIPT_PATH_BACK not set. 'Return to PTV' button/!ptv command / Custom Mode End disabled.");
if (!customRefreshAhkPath) console.warn("Warning: CUSTOM_REFRESH_AHK_SCRIPT_PATH not set. 'Refresh' button/!refresh while in custom mode will be disabled.");
if (!skipCustomAhkPath) console.warn("Warning: SKIP_CUSTOM_AHK_SCRIPT_PATH not set. 'Skip Vote' button/!skip command disabled.");
if (!openFileAhkPath) console.warn("Warning: OPEN_FILE_AHK_PATH not set. '!browse' file selection/poll function disabled.");
if (!videoDownloadFolder) { console.warn("Warning: VIDEO_DOWNLOAD_FOLDER not set in .env. YouTube download and '!browse'/remote browse commands disabled."); }
else if (!fs.existsSync(videoDownloadFolder)) { console.warn(`Warning: VIDEO_DOWNLOAD_FOLDER path not found: "${videoDownloadFolder}". '!browse' and YouTube downloads may fail.`); }
if (!fileManagementUrl) console.warn("Warning: FILE_MANAGEMENT_URL not set in .env. Help text/Youtube confirmation will be less informative.");
if (ytDlpPath && !fs.existsSync(ytDlpPath)) { console.warn(`Warning: YT_DLP_PATH env var is set but path not found: "${ytDlpPath}". yt-dlp-exec will try to find yt-dlp in PATH.`); }
if (ffmpegPath && !fs.existsSync(ffmpegPath)) { console.warn(`Warning: FFMPEG_PATH set but not found: "${ffmpegPath}". Re-encoding via 'Add Video (URL)'/!youtube will fail.`); }


// --- Discord Client Setup ---
// Initializes the Discord client with necessary intents and partials.
// Intents dictate which events the bot receives from Discord.
// Partials allow caching of structures (like channels/messages) that might not be fully available otherwise.
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, // Access guild information
        GatewayIntentBits.GuildMessages, // Access message content in guilds
        GatewayIntentBits.MessageContent, // **Required** privileged intent to read message content
        GatewayIntentBits.GuildScheduledEvents, // Manage scheduled events
        GatewayIntentBits.GuildVoiceStates, // Access voice channel status (for skip bypass, event management)
    ],
    partials: [
        Partials.Channel, // Allows receiving DMs or other channel events where cache might be incomplete
        Partials.Message // Allows receiving reactions/edits for uncached messages
    ],
});

// --- Global State Variables ---
// These variables hold the bot's current operational state.
let tvGuideTargetChannel = null; // Discord TextChannel object for schedule posts
let targetVoiceChannel = null; // Discord VoiceChannel object for scheduled events
let managedGuildEvent = null; // Discord GuildScheduledEvent object being managed by the bot
let isCustomModeActive = false; // Boolean flag indicating if Custom Channel mode is active
let customModeTimerId = null; // NodeJS Timeout ID for the 'Still Watching?' prompt
let stillWatchingPromptMessage = null; // Discord Message object for the 'Still Watching?' prompt
let skipVoteCooldownEndTimestamp = 0; // Timestamp (ms) when the next skip vote can start
let consecutiveSkipVotes = 0; // Counter for consecutive successful skip votes (reduces poll duration)
let isYoutubeDownloadActive = false; // Boolean flag indicating if a yt-dlp download is in progress
let currentYoutubeDownloadMessage = null; // Discord Message object displaying download status
let etaUpdateIntervalId = null; // NodeJS Interval ID for updating download ETA
let currentDownloadJob = null; // Object holding details of the current download ({ url, sourceChannel, user, subfolder })
let currentAbortController = null; // AbortController instance to cancel the current yt-dlp process
let vlcTitleCheckIntervalId = null; // NodeJS Interval ID for periodically checking VLC title in custom mode

/**
 * @typedef {Object} YoutubeQueueItem
 * @property {string} url - The YouTube video URL to download.
 * @property {import('discord.js').TextBasedChannel} sourceChannel - The channel where the request originated.
 * @property {import('discord.js').User} user - The user who requested the download.
 * @property {string | null} [subfolder] - Optional: The requested subfolder name to download into.
 */
/** @type {Array<YoutubeQueueItem>} */
const youtubeQueue = []; // Array acting as the queue for pending YouTube downloads

/**
 * @typedef {Object} BrowseSessionData
 * @property {Array<{ name: string; isDirectory: boolean; birthtimeMs?: number }>} items - Filtered items currently visible on the page.
 * @property {Array<{ name: string; isDirectory: boolean; birthtimeMs?: number }>} allDirectoryItems - All items in the current directory (unfiltered).
 * @property {number} currentPage - The current page number being viewed.
 * @property {number} totalPages - The total number of pages for the current view.
 * @property {string} currentPath - The relative path being browsed (from videoDownloadFolder).
 * @property {string | null} searchQuery - The active search query, or null if none.
 * @property {string} originalUser - The ID of the user who initiated the browse session.
 * @property {import('discord.js').Interaction | null} interaction - The last interaction object within the session.
 * @property {import('discord.js').MessageCollector | null} numberInputCollector - Collector for selecting item by number.
 * @property {import('discord.js').MessageCollector | null} searchInputCollector - Collector for search query input.
 * @property {import('discord.js').InteractionCollector<import('discord.js').ButtonInteraction> | null} browsePollCollector - Collector for the file play confirmation poll buttons.
 * @property {import('discord.js').Message | null} browsePollMessage - The message containing the file play confirmation poll.
 * @property {import('discord.js').InteractionCollector<import('discord.js').ButtonInteraction> | null} buttonCollector - The main collector for browse navigation/action buttons.
 */
/** @type {Map<string, BrowseSessionData>} */
const activeBrowseSessions = new Map(); // Maps message ID to active browse session data

// =============================================================================
// === Helper Functions ===
// =============================================================================

/**
 * Formats a 24-hour time string (HH:MM) into a 12-hour format (h:mm AM/PM).
 * @param {string} timeString - The time string in HH:MM format.
 * @returns {string} The formatted time string or the original string if invalid.
 */
function formatTime12hr(timeString) {
    if (!timeString || !timeString.includes(':')) return timeString;
    const [hourStr, minuteStr] = timeString.split(':');
    let hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);
    if (isNaN(hour) || isNaN(minute)) return timeString; // Invalid input
    const ampm = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12;
    hour = hour ? hour : 12; // Convert 0 hour to 12
    const minutePadded = String(minute).padStart(2, '0');
    return `${hour}:${minutePadded} ${ampm}`;
}

/**
 * Formats a message for the TV Guide channel based on schedule data.
 * Handles both standard "Now/Next" entries and custom messages.
 * @param {object} showData - The schedule entry object for the current time slot.
 * @returns {string} The formatted message string.
 */
function formatTvGuideMessage(showData) {
    if (!showData) return "Error: Schedule data missing.";
    // Use custom message directly if provided
    if (showData.customMessage && typeof showData.customMessage === 'string') {
        return showData.customMessage;
    }
    // Handle standard entries
    if (!showData.now || !showData.next) {
        console.warn(`[${new Date().toLocaleString()}] formatTvGuideMessage: Received invalid standard entry (missing now/next):`, JSON.stringify(showData));
        return "Schedule information is currently unavailable.";
    }
    // Build standard message
    let message = `Now Playing: **${showData.now}**\nUp Next: **${showData.next}**`;
    // Append image URL if provided
    if (showData.image && typeof showData.image === 'string' && showData.image.trim() !== '') {
        message += `\n${showData.image.trim()}`;
    }
    return message;
}

/**
 * Gets the full schedule data object for the currently playing show based on `schedule.js`.
 * Only considers standard entries (with 'now' and 'next').
 * @returns {object | null} The schedule data object or null if none found.
 */
function getCurrentShowData() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
    const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const todaysSchedule = schedule[dayOfWeek];

    if (!todaysSchedule) return null; // No schedule defined for today

    // Sort scheduled times to find the latest one that has passed
    const scheduledTimes = Object.keys(todaysSchedule).sort();
    let lastValidData = null;

    for (const time of scheduledTimes) {
        if (time > currentTimeStr) break; // Stop if we've passed the current time
        const showData = todaysSchedule[time];
        // Only consider standard entries for defining the "current" show
        if (showData && showData.now && showData.next) {
            lastValidData = showData;
        }
    }
    return lastValidData;
}

/**
 * Gets only the title of the currently playing show (for event names).
 * Strips markdown formatting.
 * @returns {string | null} The show title or null if none found.
 */
function getCurrentShowTitle() {
    const data = getCurrentShowData();
    // Remove markdown (like **) and trim whitespace
    return data ? data.now.replace(/\*+/g, '').trim() : null;
}

/**
 * Attempts to get the window title of a running VLC process (Windows-only).
 * Uses the `tasklist` command.
 * @returns {Promise<string | null>} The cleaned VLC window title (without " - VLC media player") or null if not found/error.
 */
async function getVlcTitle() {
    const timestamp = `[${new Date().toLocaleString()}] VLC Title Check`;

    // This method is specific to Windows
    if (process.platform !== 'win32') {
        // console.log(`${timestamp}: Skipping: Tasklist method only supported on Windows.`);
        return null;
    }

    try {
        // Command to list verbose task info for vlc.exe, filter by image name, format as CSV, no header
        const tasklistCmd = 'tasklist /v /fi "imagename eq vlc.exe" /fo csv /nh';
        // NOTE: Reduced logging verbosity for interval checks. Uncomment if debugging.
        // console.log(`${timestamp}: Running command: ${tasklistCmd}`);

        const { stdout, stderr } = await new Promise((resolve, reject) => {
             exec(tasklistCmd, { timeout: 5000 }, (error, stdout, stderr) => { // 5-second timeout
                // Handle common scenarios where 'error' is set but we might still proceed or ignore
                if (error && !stdout) {
                    if (error.killed) return reject(new Error('Tasklist command timed out'));
                    // ERRORLEVEL 1 with "INFO: No tasks running..." is common if VLC isn't open. Treat as non-fatal.
                    if (error.message?.includes('No tasks are running')) {
                        // console.log(`${timestamp}: Tasklist reported no running vlc.exe process (via error message).`);
                        return resolve({ stdout: '', stderr: '' });
                    }
                    // Other errors are more problematic
                    return reject(new Error(`VLC process not found or error executing tasklist: ${error.message}. Stderr: ${stderr}`));
                }
                // If error code is non-zero but we got stdout, log a warning but proceed
                if (error) {
                     console.warn(`${timestamp}: Tasklist executed with error code ${error.code}, but received stdout. Processing output. Stderr: ${stderr}`);
                }
                resolve({ stdout, stderr });
            });
        });

        // If no standard output, VLC is likely not running or has no title
        if (!stdout || !stdout.trim()) {
            // console.log(`${timestamp}: Tasklist found no running vlc.exe process or stdout was empty.`);
            return null;
        }

        // Process the CSV output
        const lines = stdout.trim().split('\n');
        let vlcTitle = null;

        for (const line of lines) {
            // Attempt robust CSV parsing (handles quoted fields with commas)
            const columns = [];
            let currentField = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                // Handle quotes (basic, doesn't handle escaped quotes within fields)
                if (char === '"' && (i === 0 || line[i-1] !== '\\')) {
                    inQuotes = !inQuotes;
                } else if (char === ',' && !inQuotes) {
                    columns.push(currentField.trim());
                    currentField = '';
                } else {
                    currentField += char;
                }
            }
            columns.push(currentField.trim()); // Add the last field

            // The Window Title is typically the 9th column (index 8) in verbose output
            if (columns && columns.length > 8) {
                const potentialTitle = columns[8].replace(/^"|"$/g, ''); // Remove surrounding quotes
                // Check if the title is meaningful (not 'N/A' or just the application name)
                if (potentialTitle && potentialTitle !== 'N/A' && potentialTitle.toLowerCase() !== 'vlc media player') {
                     vlcTitle = potentialTitle;
                     break; // Found a likely title, use the first one encountered
                }
            }
        }

        if (vlcTitle) {
            // Clean the title by removing the standard VLC suffix
            const suffix = " - VLC media player";
            let cleanTitle = vlcTitle;
            if (cleanTitle.endsWith(suffix)) {
                cleanTitle = cleanTitle.substring(0, cleanTitle.length - suffix.length).trim();
            }
            // console.log(`${timestamp}: Found and cleaned VLC title: "${cleanTitle}"`);
            return cleanTitle;
        } else {
            // console.log(`${timestamp}: Found VLC process(es), but couldn't determine a playing title from tasklist.`);
            return null; // Found process but no usable title
        }
    } catch (error) {
         // Avoid logging timeout errors repeatedly if running on an interval
         if (!error.message?.includes('timed out')) {
             console.error(`${timestamp}: Error getting VLC title:`, error);
         }
         return null; // Error occurred during the process
    }
}

/**
 * Finds an existing active/scheduled Discord Scheduled Event managed by this bot
 * in the target voice channel, or creates a new one if none is found.
 * Requires 'Manage Events' permission.
 * @param {import('discord.js').Guild} guild - The guild object.
 * @returns {Promise<import('discord.js').GuildScheduledEvent | null>} The found/created event or null on error/missing config.
 */
async function findOrCreateManagedEvent(guild) {
    if (!targetVoiceChannel || !guild) {
        console.error("[Event Manager] Cannot find/create event: Target voice channel or guild object not available.");
        return null;
    }

    const botId = client.user.id;
    let foundEvent = null;

    try {
        // Fetch all scheduled events in the guild
        const events = await guild.scheduledEvents.fetch();

        // Find an event created by this bot, for the target voice channel, that isn't finished
        foundEvent = events.find(event =>
            event.creatorId === botId &&
            event.channelId === targetVoiceChannel.id &&
            event.status !== GuildScheduledEventStatus.Completed &&
            event.status !== GuildScheduledEventStatus.Canceled
        );

        if (foundEvent) {
            console.log(`[Event Manager] Found existing event: "${foundEvent.name}" (ID: ${foundEvent.id}, Status: ${GuildScheduledEventStatus[foundEvent.status]})`);
            // If the event is scheduled but its start time is in the past, attempt to start it
            if (foundEvent.status === GuildScheduledEventStatus.Scheduled && foundEvent.scheduledStartTimestamp < Date.now()) {
                console.log(`[Event Manager] Existing event is SCHEDULED but start time has passed. Attempting to set to ACTIVE...`);
                try {
                    foundEvent = await foundEvent.setStatus(GuildScheduledEventStatus.Active);
                    console.log(`[Event Manager] Event status successfully set to ACTIVE.`);
                } catch(startError) {
                    console.error(`[Event Manager] Failed to set existing past-due event status to ACTIVE:`, startError);
                }
            }
            return foundEvent;
        } else {
            // No suitable existing event found, create a new one
            console.log(`[Event Manager] No suitable existing event found. Creating new event...`);
            const initialName = isCustomModeActive ? "Custom Channel" : (getCurrentShowTitle() || "Stream Starting Soon");
            const startTime = new Date(Date.now() + 5000); // Start 5 seconds from now
            const endTime = new Date(startTime.getTime() + (4 * 60 * 60 * 1000)); // Default duration 4 hours

            const newEvent = await guild.scheduledEvents.create({
                name: initialName.substring(0, 100), // Ensure name is within Discord limits
                scheduledStartTime: startTime,
                scheduledEndTime: endTime,
                privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly, // Only visible to guild members
                entityType: GuildScheduledEventEntityType.Voice, // Event is for a voice channel
                channel: targetVoiceChannel.id, // Link to the target voice channel
                description: "Live stream schedule event managed by the bot." // Optional description
            });
            console.log(`[Event Manager] Created new event "${newEvent.name}" (ID: ${newEvent.id}). Attempting to start immediately...`);

            // Attempt to start the newly created event immediately
            try {
                 await newEvent.setStatus(GuildScheduledEventStatus.Active);
                 console.log(`[Event Manager] New event status set to ACTIVE.`);
                 return newEvent;
            } catch(startError) {
                 // It might be too soon to start it; this is usually fine.
                 console.warn(`[Event Manager] Could not immediately set new event status to ACTIVE (might be too soon):`, startError.message);
                 return newEvent; // Return the scheduled event anyway
            }
        }
    } catch (error) {
        console.error(`[Event Manager] Error finding or creating scheduled event:`, error);
        if (error.code === 50013) { // Missing Permissions
             console.error("   -> PERMISSION ERROR: The bot likely lacks the 'Manage Events' permission in the server or for the specific channel.");
        }
        return null;
    }
}

/**
 * Internal helper to update the managed Discord Scheduled Event's name.
 * This version bypasses the `isCustomModeActive` check allowing forced updates.
 * It handles fetching the latest event state and ensures the event is active if needed.
 * Automatically prefixes with "Custom Channel: " if in custom mode and the name isn't just "Custom Channel".
 * @param {string} newName - The desired base name for the event (e.g., show title, file name without extension).
 * @returns {Promise<boolean>} True if the update was successful or unnecessary (name already set), false otherwise.
 */
async function updateEventNameInternal(newName) {
    // Prerequisite check
    if (!targetVoiceChannel) {
        // console.warn("[Event Update Internal] Target voice channel not available."); // Less verbose
        return false;
    }

    // Ensure we have a valid event reference, try to re-acquire if missing/invalid
    if (!managedGuildEvent || managedGuildEvent.status === GuildScheduledEventStatus.Completed || managedGuildEvent.status === GuildScheduledEventStatus.Canceled) {
        // console.warn(`[Event Update Internal] Event reference missing or invalid (Status: ${managedGuildEvent?.status}). Re-acquiring...`);
        const guild = client.guilds.cache.get(targetVoiceChannel?.guild?.id);
        if (guild) {
            managedGuildEvent = await findOrCreateManagedEvent(guild);
            if (!managedGuildEvent) {
                 // console.error(`[Event Update Internal] Failed re-acquiring event.`); // Less verbose
                 return false;
            }
            // console.log(`[Event Update Internal] Re-acquired event (ID: ${managedGuildEvent.id}).`); // Less verbose
        } else {
            // console.error(`[Event Update Internal] Cannot re-acquire event: Guild not found.`); // Less verbose
             return false;
        }
    }

    // Validate the provided name
    let nameToSet = newName;
    if (!nameToSet || typeof nameToSet !== 'string' || nameToSet.trim() === '') {
        console.warn(`[Event Update Internal] Attempted event name update with invalid name: "${nameToSet}"`);
        // If in custom mode and name is invalid, force it to the default custom name
        if (isCustomModeActive && managedGuildEvent?.name !== "Custom Channel") {
            nameToSet = "Custom Channel";
            console.warn(`[Event Update Internal] Invalid name provided during custom mode. Forcing name to "Custom Channel".`);
        } else {
             return false; // Invalid name in standard mode, do nothing
        }
    }

    // Apply "Custom Channel: " prefix if needed
    if (isCustomModeActive && nameToSet !== "Custom Channel") {
        nameToSet = `Custom Channel: ${nameToSet}`;
        // console.log(`[Event Update Internal] Custom mode active. Formatting event name to "${nameToSet}".`);
    }
    // If custom mode is active and nameToSet IS "Custom Channel", it's used as is.
    // If custom mode is NOT active, nameToSet (show title) is used as is.

    // Ensure final name is within Discord's 100-character limit
    const finalName = nameToSet.trim().substring(0, 100);

    try {
        // Fetch the latest event state *only* if the name is actually different (optimization)
        let currentEventState = managedGuildEvent;
        if (currentEventState.name !== finalName) {
            const fetchedState = await client.guilds.cache.get(managedGuildEvent.guildId)?.scheduledEvents.fetch(managedGuildEvent.id, { force: true }).catch(() => null);
            if (!fetchedState) {
                 // Handle case where event disappears between checks
                 console.warn(`[Event Update Internal] Failed to fetch current event state (ID: ${managedGuildEvent?.id}). Event might be deleted. Clearing reference.`);
                 managedGuildEvent = null;
                 return false;
            }
            currentEventState = fetchedState;
            managedGuildEvent = fetchedState; // Update global reference
        }

        // Check status again after potential fetch
        if(currentEventState.status === GuildScheduledEventStatus.Completed || currentEventState.status === GuildScheduledEventStatus.Canceled){
            console.warn(`[Event Update Internal] Managed event (ID: ${currentEventState.id}) became COMPLETED or CANCELLED before update.`);
            managedGuildEvent = null; // Clear reference to invalid event
            return false;
        }

        // Edit the event name if it differs
        if (currentEventState.name !== finalName) {
            console.log(`[Event Update Internal] Updating event name from "${currentEventState.name}" to "${finalName}" (ID: ${currentEventState.id})`);
            await currentEventState.edit({ name: finalName });
            // console.log(`   -> Event name updated successfully.`); // Less verbose
        } else {
            // console.log(`[Event Update Internal] Event name "${finalName}" is already set.`); // Less verbose
        }

        // If the event is somehow still 'Scheduled' but should be active, activate it
        if (currentEventState.status === GuildScheduledEventStatus.Scheduled && currentEventState.scheduledStartTimestamp < Date.now()) {
             console.log(`[Event Update Internal] Event status is SCHEDULED but start time passed. Setting to ACTIVE...`);
             await currentEventState.setStatus(GuildScheduledEventStatus.Active);
             console.log(`   -> Event status set to ACTIVE.`);
             managedGuildEvent = await currentEventState.fetch(true); // Refresh state after update
        }

        return true; // Update successful or unnecessary

    } catch (error) {
        console.error(`[Event Update Internal] Error updating scheduled event (ID: ${managedGuildEvent?.id}):`, error);
        if (error.code === 50013) { // Missing permissions
            console.error("   -> PERMISSION ERROR: Bot likely lacks 'Manage Events' permission.");
        }
        // Handle common error indicating the event no longer exists
        if (error.code === 10062 || error.message.includes('Unknown Scheduled Event')) {
            console.warn(`[Event Update Internal] Event seems to have been deleted externally. Clearing reference.`);
            managedGuildEvent = null; // Clear the reference
        }
        return false; // Update failed
    }
}

/**
 * Public helper to update the managed Discord Scheduled Event's name.
 * Defers to `updateEventNameInternal`. Primarily used by scheduled tasks.
 * The caller should provide the clean base name (e.g., show title).
 * @param {string} newName - The desired base name for the event.
 * @returns {Promise<boolean>} True if the update was successful or unnecessary, false otherwise.
 */
async function updateEventName(newName) {
    // Note: Extension stripping or other cleaning should happen *before* calling this
    // if the source is a filename (e.g., from VLC or !browse).
    // Standard schedule updates use the show title directly.
    return await updateEventNameInternal(newName);
}

/**
 * Executes an AutoHotkey (.ahk) script using Node.js's child_process.exec.
 * IMPORTANT: This function relies on AutoHotkey being installed and associated
 *            with .ahk files on the Windows machine running the bot.
 *            It also directly executes external code, requiring careful security
 *            considerations regarding script paths and arguments.
 * @param {string} scriptPath - The absolute or relative path to the .ahk script.
 * @param {string} [scriptName='script'] - A descriptive name for logging purposes.
 * @param {...string} args - Arguments to pass to the AHK script.
 * @returns {Promise<{stdout: string, stderr: string}>} Resolves with stdout/stderr on success.
 * @throws {Error} Rejects with an error if the script path is invalid, not found, or execution fails.
 */
function runAhkScript(scriptPath, scriptName = 'script', ...args) {
    return new Promise((resolve, reject) => {
        // --- Path Validation ---
        if (!scriptPath) {
            const errMsg = `Path for AHK script '${scriptName}' not configured in .env file.`;
            console.warn(`[${new Date().toLocaleString()}] Cannot run ${scriptName}: ${errMsg}`);
            return reject(new Error(errMsg));
        }
        // Check if the provided path exists
        if (!fs.existsSync(scriptPath)) {
            const errMsg = `AHK script file not found at configured path: ${scriptPath}`;
            console.error(`[${new Date().toLocaleString()}] Cannot run ${scriptName}: ${errMsg}`);
            return reject(new Error(errMsg));
        }

        // Resolve to an absolute path for clarity and consistency
        const absoluteScriptPath = path.resolve(scriptPath);
        if (!fs.existsSync(absoluteScriptPath)) {
            // This check is somewhat redundant if the first check passes, but good practice
            const errMsg = `Resolved absolute AHK script file path not found: ${absoluteScriptPath}`;
            console.error(`[${new Date().toLocaleString()}] Cannot run ${scriptName}: ${errMsg}`);
            return reject(new Error(errMsg));
        }

        // --- Argument Quoting ---
        // Basic quoting for arguments passed to the script. Handles spaces.
        // Might need more robust escaping for complex arguments containing special shell characters.
        const quotedArgs = args.map(arg => `"${String(arg).replace(/"/g, '""')}"`).join(' ');

        // --- Command Construction ---
        // Assumes AutoHotkey executable is in PATH or .ahk files are associated.
        // Quotes the script path itself to handle spaces in the path.
        const command = `"${absoluteScriptPath}" ${quotedArgs}`;

        console.log(`[${new Date().toLocaleString()}] Attempting to execute ${scriptName} via exec: ${command}`);

        // --- Execution ---
        // NOTE: Timeout for exec was INTENTIONALLY REMOVED as per user request (GitHub issue prep).
        // This means a hanging AHK script could potentially block this part of the bot indefinitely.
        // Consider adding a timeout back in production if scripts are unreliable. e.g. { timeout: 15000 }
        exec(command, /* { timeout: 15000 } */ (error, stdout, stderr) => {
            if (error) {
                let logFunc = console.error;
                let reason = `ERROR EXECUTING ${scriptName.toUpperCase()}`;
                // Check if the error was due to the process being killed (e.g., by a timeout if one was set)
                if (error.killed) {
                    reason = `TIMEOUT EXECUTING ${scriptName.toUpperCase()}`;
                    logFunc = console.warn;
                }

                // Log detailed error information
                logFunc(`[${new Date().toLocaleString()}] !!! ${reason} (${absoluteScriptPath}) !!!`);
                logFunc(`➡️ Exit Code: ${error.code}`);
                logFunc(`➡️ Signal: ${error.signal}`);
                logFunc(`➡️ Error Message: ${error.message}`);
                if (stderr) { logFunc(`➡️ Stderr Output:\n${stderr}`); }
                // Log stack trace for non-timeout errors
                if (error.stack && !error.killed) { logFunc(error.stack); }
                logFunc(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);

                return reject(error); // Reject the promise with the error object
            }

            // Log standard error output even on success (AHK might write info/warnings to stderr)
            if (stderr) {
                console.warn(`[${new Date().toLocaleString()}] Stderr/Info from ${scriptName} (${absoluteScriptPath}):\n${stderr}`);
            }

            // Log standard output
            console.log(`[${new Date().toLocaleString()}] Successfully executed ${scriptName} (${absoluteScriptPath}). Stdout:\n${stdout.trim() || '(No Stdout)'}`);

            resolve({ stdout, stderr }); // Resolve the promise with outputs
        });
    });
}

/**
 * Sends a message to a Discord channel, splitting it into multiple messages
 * if it exceeds the DISCORD_MESSAGE_LIMIT. Tries to split at newlines.
 * @param {import('discord.js').TextBasedChannel} channel - The channel to send the message to.
 * @param {string} content - The message content to send.
 * @param {string} [prefix=''] - Optional prefix for each chunk.
 * @param {string} [suffix=''] - Optional suffix for each chunk.
 * @returns {Promise<void>}
 */
async function sendSplitMessage(channel, content, prefix = '', suffix = '') {
    if (!channel || !content) return; // Basic validation

    // Calculate max length for each chunk, leaving buffer for prefix, suffix, and potential markdown/spacing
    const maxChunkLength = DISCORD_MESSAGE_LIMIT - prefix.length - suffix.length - 10; // Extra buffer
    let remainingContent = content;

    while (remainingContent.length > 0) {
        let chunk;
        if (remainingContent.length <= maxChunkLength) {
            // Last chunk or only chunk
            chunk = remainingContent;
            remainingContent = '';
        } else {
            // Find the last newline within the allowed length
            let splitIndex = remainingContent.lastIndexOf('\n', maxChunkLength);

            // If no newline found, or it's at the very beginning, just split at the max length
            if (splitIndex <= 0) {
                splitIndex = maxChunkLength;
            }

            chunk = remainingContent.substring(0, splitIndex);
            // Prepare the next chunk, removing the split point and any leading whitespace
            remainingContent = remainingContent.substring(splitIndex).trimStart();
        }

        try {
            // Send the chunk with prefix and suffix
            await channel.send(prefix + chunk + suffix);
        } catch (e) {
            console.error(`[sendSplitMessage] Error sending message chunk to channel ${channel.id}:`, e);
            // Stop trying to send further chunks if one fails
            break;
        }
    }
}

/**
 * Checks if a GuildMember has Administrator or Manage Guild permissions.
 * @param {import('discord.js').GuildMember | null | undefined} member - The guild member object.
 * @returns {boolean} True if the member is considered an admin, false otherwise.
 */
function isAdmin(member) {
    if (!member) return false;
    // Check for Administrator OR Manage Server (often sufficient for bot control)
    return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
           member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

/**
 * Sanitizes a potential subfolder name provided by a user.
 * Prevents path traversal, removes invalid characters, replaces spaces, trims,
 * and limits length.
 * @param {string | null | undefined} name - The potential subfolder name.
 * @returns {string | null} The sanitized name, or null if the input was invalid/empty after cleaning.
 */
function sanitizeSubfolderName(name) {
    if (!name || typeof name !== 'string') return null;

    // 1. Use path.basename to prevent traversal attempts like "../", "/etc/passwd" etc.
    //    This effectively isolates the last part of the path.
    let cleanName = path.basename(name);

    // 2. Remove characters invalid for Windows filenames/paths and potentially harmful ones.
    //    Also replace whitespace with underscores (optional, but common).
    cleanName = cleanName.replace(INVALID_PATH_CHARS_REGEX, '_').replace(/\s+/g, '_');

    // 3. Trim leading/trailing underscores that might result from replacement.
    cleanName = cleanName.replace(/^_+|_+$/g, '').trim();

    // 4. If the name is empty after cleaning, return null.
    if (cleanName === '') return null;

    // 5. Limit the length to avoid excessively long paths.
    return cleanName.substring(0, 50);
}

// --- Command List for Help Message ---
const commandList = `
\`!remote\` - Get an interactive message with buttons for bot actions.
\`!now\` - Show what's currently scheduled or playing in VLC (Custom Mode). Updates event name.
\`!browse\` - Browse downloadable files (Custom Mode Only). Requires poll to open. Supports subfolders & search.
\`!schedule\` - Show the schedule for today or the week.
\`!refresh\` - Trigger the bot to refresh the current show info and run the refresh script.
\`!youtube <URL> [Subfolder Name]\` - Add YouTube video/playlist. Optionally specify a subfolder to download into.
\`!help\` - Show this help message.
\`!clear\` - (Admin) Delete the bot's recent messages in this channel.
`;
const customModeCommandList = `
\`!custom\` - (Vote) Start Custom Channel mode.
\`!ptv\` - (Vote) End Custom Channel mode and return to schedule.
\`!skip\` - (Vote) Skip the current item in Custom Channel mode. (Bypassed with 2 users in VC)
\`!cancel\` - Cancel your currently downloading or queued YouTube videos.
\`!toggle\` - (Admin) Toggle between Custom/Scheduled mode *without* running scripts.
\`!cancelall\` - (Admin) Cancel all active and queued YouTube downloads.
`;


// =============================================================================
// === Scheduling Logic (node-cron) ===
// =============================================================================

/**
 * Sets up cron jobs based on the `schedule.js` configuration.
 * Schedules posts to the TV Guide channel and updates the Discord Scheduled Event name.
 * Jobs are skipped if `isCustomModeActive` is true.
 */
function setupCronJobs() {
    // Only proceed if at least one target channel is configured
    if (!tvGuideTargetChannel && !targetVoiceChannel) {
        console.log("[Cron] Neither TV Guide post channel nor Event Voice channel are configured. No cron jobs scheduled.");
        return;
    }

    console.log("[Cron] Setting up scheduled jobs (Timezone: America/New_York)...");
    let jobCount = 0;

    // Iterate through each day in the schedule
    for (const dayOfWeek in schedule) {
        const daySchedule = schedule[dayOfWeek];
        // Iterate through each time slot in the day's schedule
        for (const time in daySchedule) {
            // Create a copy of the show data for this specific job instance
            const showDataForThisJob = { ...schedule[dayOfWeek][time] };
            const [hour, minute] = time.split(':');

            // Validate time format
            if (isNaN(parseInt(hour)) || isNaN(parseInt(minute))) {
                console.warn(`[Cron] Skipping invalid time format in schedule: Day ${dayOfWeek}, Time ${time}`);
                continue;
            }

            // Format: minute hour * * dayOfWeek (e.g., "30 14 * * 1" for 2:30 PM on Monday)
            const cronPattern = `${minute} ${hour} * * ${dayOfWeek}`;

            try {
                // Schedule the job
                cron.schedule(cronPattern, async () => {
                    const timestamp = `[${new Date().toLocaleString()}] CRON Day ${dayOfWeek}@${time}`;
                    console.log(`${timestamp}: Job triggered.`);

                    // --- Skip if in Custom Mode ---
                    if (isCustomModeActive) {
                        console.log(`${timestamp}: Custom mode active. Skipping scheduled actions.`);
                        return;
                    }

                    // --- Post to TV Guide Channel ---
                    if (tvGuideTargetChannel) {
                        const messageToSend = formatTvGuideMessage(showDataForThisJob);
                        console.log(`${timestamp}: Formatting TV guide post...`);
                        try {
                            await tvGuideTargetChannel.send(messageToSend);
                            console.log(`${timestamp}: TV guide message sent to #${tvGuideTargetChannel.name}.`);
                        } catch (err) {
                            console.error(`${timestamp}: ERROR sending TV guide message:`, err.message || err);
                        }
                    }

                    // --- Update Discord Scheduled Event Name (only for standard entries) ---
                    if (targetVoiceChannel && showDataForThisJob.now && showDataForThisJob.next) {
                        // Extract and clean the show title for the event name
                        const eventName = showDataForThisJob.now.replace(/\*+/g, '').trim();
                        console.log(`${timestamp}: Formatting event name update... (Name: "${eventName}")`);
                        if (eventName) {
                            await updateEventName(eventName); // Use the public helper
                        } else {
                            console.warn(`${timestamp}: Extracted empty event name from standard schedule entry. Skipping event update.`);
                        }
                    } else if (targetVoiceChannel) {
                        // Log if the entry is custom or invalid, skipping event update
                        console.log(`${timestamp}: Schedule entry is custom or lacks 'now/next'. Skipping event name update.`);
                    }
                }, {
                    scheduled: true,
                    timezone: "America/New_York" // IMPORTANT: Set your bot's operating timezone
                });
                jobCount++;
            } catch (error) {
                console.error(`[Cron] Error scheduling job for Day ${dayOfWeek} at ${time}:`, error);
            }
        } // End loop through times
    } // End loop through days

     console.log(`[Cron] Scheduled ${jobCount} jobs. Timezone: America/New_York`);
}

// =============================================================================
// === VLC Title Check Interval Functions (Custom Mode) ===
// =============================================================================

/**
 * Periodically checks the VLC window title (if running) during custom mode,
 * removes the file extension, and updates the Discord Scheduled Event name accordingly.
 */
async function checkAndUpdateVlcEventTitle() {
    // Only run if in custom mode and event management is set up
    if (!isCustomModeActive || !managedGuildEvent || !targetVoiceChannel) {
        // console.log("[VLC Check Interval] Skipping: Not in custom mode or no managed event/channel."); // Too verbose for interval
        return;
    }

    const vlcTitleRaw = await getVlcTitle(); // Fetches title, already removes " - VLC media player"

    // --- Clean the Title (Remove File Extension) ---
    let finalTitleForEvent = "Custom Channel"; // Default if no title found or error
    if (vlcTitleRaw) {
        const extension = path.extname(vlcTitleRaw);
        const baseName = path.basename(vlcTitleRaw, extension); // Get name without extension
        finalTitleForEvent = baseName.trim(); // Use the base name
    }
    // `finalTitleForEvent` now holds the VLC title without extension, or "Custom Channel".

    try {
        // Construct the potential full event name (e.g., "Custom Channel: My Video")
        // This is used for comparison with the current event name to avoid unnecessary updates.
        const potentialEventName = (finalTitleForEvent !== "Custom Channel")
                                   ? `Custom Channel: ${finalTitleForEvent}`
                                   : "Custom Channel";
        const finalPotentialName = potentialEventName.substring(0, 100); // Ensure length limit

        // --- Optimization: Check if name needs updating ---
        // Fetch the latest event state *only* if the potential name differs from the current one.
        if(managedGuildEvent.name === finalPotentialName) {
             // console.log("[VLC Check Interval] Event name already matches VLC title. Skipping update."); // Too verbose
             return;
        }

        // Fetch the current state of the event from Discord API to ensure it's still valid
        const currentEventState = await client.guilds.cache.get(managedGuildEvent.guildId)?.scheduledEvents.fetch(managedGuildEvent.id).catch(() => null);

        // If event not found or completed/cancelled, stop checking
        if (!currentEventState || currentEventState.status === GuildScheduledEventStatus.Completed || currentEventState.status === GuildScheduledEventStatus.Canceled) {
             console.warn("[VLC Check Interval] Managed event not found or in invalid state. Stopping interval check.");
             stopVlcTitleCheckInterval(); // Stop the interval
             managedGuildEvent = null; // Clear the reference
             return;
        }
        managedGuildEvent = currentEventState; // Update global reference

        // --- Update Event Name ---
        // Pass the cleaned title (without "Custom Channel: " prefix and without extension)
        // to the internal update function, which will handle adding the prefix correctly.
        // console.log(`[VLC Check Interval] Updating event name to match VLC (cleaned): "${finalPotentialName}"`); // Less verbose
        await updateEventNameInternal(finalTitleForEvent);

    } catch (error) {
        console.error("[VLC Check Interval] Error fetching or updating event based on VLC title:", error);
         // Handle specific case where the event disappeared
         if (error.code === 10062 || error.message.includes('Unknown Scheduled Event')) {
             console.warn(`[VLC Check Interval] Event seems to be gone. Clearing reference and stopping interval.`);
             managedGuildEvent = null;
             stopVlcTitleCheckInterval();
         }
    }
}

/**
 * Starts the interval timer to periodically check the VLC title and update the event name.
 * Only starts if in custom mode and the target voice channel is set.
 */
function startVlcTitleCheckInterval() {
    // Clear any existing interval first
    if (vlcTitleCheckIntervalId) {
        console.log("[VLC Check Interval] Clearing existing interval timer.");
        clearInterval(vlcTitleCheckIntervalId);
        vlcTitleCheckIntervalId = null;
    }
    // Start if conditions are met
    if (isCustomModeActive && targetVoiceChannel) {
        console.log(`[VLC Check Interval] Starting periodic check every ${VLC_TITLE_CHECK_INTERVAL_MS / 1000}s.`);
        vlcTitleCheckIntervalId = setInterval(checkAndUpdateVlcEventTitle, VLC_TITLE_CHECK_INTERVAL_MS);
         // Run the check once immediately after starting the interval for faster initial update
         setTimeout(checkAndUpdateVlcEventTitle, 1000); // Run after 1 second
    } else {
        console.log("[VLC Check Interval] Not starting - custom mode is inactive or target voice channel not configured.");
    }
}

/**
 * Stops the interval timer for VLC title checking.
 */
function stopVlcTitleCheckInterval() {
    if (vlcTitleCheckIntervalId) {
        console.log("[VLC Check Interval] Stopping periodic check.");
        clearInterval(vlcTitleCheckIntervalId);
        vlcTitleCheckIntervalId = null;
    }
}

// =============================================================================
// === Custom Mode Management Functions ===
// =============================================================================

/**
 * Starts the timer for the custom mode duration. When expired, prompts users
 * if they are still watching. Also starts the VLC title check interval.
 * @param {import('discord.js').TextBasedChannel} channel - The channel where the prompt should be sent.
 */
async function startCustomModeTimer(channel) {
    if (!channel) {
        console.error("[Custom Mode] Cannot start timer: Invalid channel provided.");
        return;
    }
    // Clear any existing timer
    if (customModeTimerId) {
        clearTimeout(customModeTimerId);
        console.log("[Custom Mode] Cleared existing timer before starting a new one.");
    }

    console.log(`[Custom Mode] Starting ${CUSTOM_MODE_DURATION_MS / (60 * 1000)} minute timer.`);

    // Start the periodic VLC title check when custom mode timer begins
    startVlcTitleCheckInterval();

    // Set the main timer
    customModeTimerId = setTimeout(async () => {
        console.log("[Custom Mode] Timer expired. Sending 'Still Watching?' prompt.");
        customModeTimerId = null; // Timer has fired

        // Clean up previous prompt message if it somehow still exists
        if (stillWatchingPromptMessage) {
            await stillWatchingPromptMessage.delete().catch(e => console.warn("Could not delete previous 'Still Watching?' prompt message:", e.message));
            stillWatchingPromptMessage = null;
        }

        // Create prompt buttons
        const promptRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('still_watching_yes').setLabel('Yes, Keep Watching').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('still_watching_no').setLabel('No, Return to Schedule').setStyle(ButtonStyle.Danger),
        );

        try {
            // Send the prompt message
            stillWatchingPromptMessage = await channel.send({
                content: `🕒 The ${CUSTOM_MODE_DURATION_MS / (60 * 60 * 1000)}-hour Custom Channel timer is up! Still watching? (Auto-stops in ${STILL_WATCHING_TIMEOUT_MS / 60000}m)`,
                components: [promptRow]
            });

            // Create a collector for the prompt buttons
            const collector = stillWatchingPromptMessage.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: STILL_WATCHING_TIMEOUT_MS // 5-minute timeout for the prompt
            });

            collector.on('collect', async i => {
                await i.deferUpdate(); // Acknowledge button click immediately

                if (i.customId === 'still_watching_yes') {
                    console.log(`[Custom Mode] User ${i.user.tag} confirmed 'Yes'. Restarting timer.`);
                    await stillWatchingPromptMessage.edit({ content: `Okay, restarting the ${CUSTOM_MODE_DURATION_MS / (60 * 60 * 1000)}-hour timer!`, components: [] }).catch(e => console.error("Error editing 'Still Watching' prompt:", e));
                    stillWatchingPromptMessage = null;
                    collector.stop('answered_yes');
                    startCustomModeTimer(channel); // Restart the main timer and VLC check interval

                } else if (i.customId === 'still_watching_no') {
                    console.log(`[Custom Mode] User ${i.user.tag} confirmed 'No'. Ending custom mode.`);
                    await stillWatchingPromptMessage.edit({ content: `Okay, switching back to the regular schedule...`, components: [] }).catch(e => console.error("Error editing 'Still Watching' prompt:", e));
                    stillWatchingPromptMessage = null;
                    collector.stop('answered_no');
                    await endCustomMode(channel, "User requested stop via prompt."); // End custom mode, stopping VLC check interval inside
                }
            });

            collector.on('end', async (collected, reason) => {
                console.log(`[Custom Mode] 'Still Watching?' prompt collector ended. Reason: ${reason}`);
                // If the collector ended because it timed out
                if (stillWatchingPromptMessage && reason === 'time') {
                    console.log(`[Custom Mode] Prompt timed out (${STILL_WATCHING_TIMEOUT_MS / 60000} minutes). Assuming 'No', ending custom mode.`);
                    await stillWatchingPromptMessage.edit({ content: `No response received in ${STILL_WATCHING_TIMEOUT_MS / 60000} minutes. Switching back to the regular schedule...`, components: [] }).catch(e => console.error("Error editing timed-out 'Still Watching' prompt:", e));
                    stillWatchingPromptMessage = null;
                    await endCustomMode(channel, "Still Watching prompt timed out."); // End custom mode, stopping VLC check interval inside
                } else if (stillWatchingPromptMessage) {
                    // If ended for other reasons (answered), delete the prompt message
                    await stillWatchingPromptMessage.delete().catch(e => console.warn("Could not delete answered 'Still Watching' prompt:", e.message));
                    stillWatchingPromptMessage = null;
                }
            });

        } catch (error) {
            console.error("[Custom Mode] Error sending/collecting 'Still Watching?' prompt:", error);
            // Attempt to end custom mode gracefully even if the prompt failed
            await endCustomMode(channel, "Error during 'Still Watching?' prompt."); // Stops interval inside
        }
    }, CUSTOM_MODE_DURATION_MS); // The main timer duration
}

/**
 * Ends Custom Channel mode, executes the 'switch back' AHK script,
 * clears timers/intervals, updates the event name, and sends feedback.
 * @param {import('discord.js').Interaction | import('discord.js').Message | import('discord.js').TextBasedChannel} initiatingObject - The interaction, message, or channel that triggered the end. Used for context-aware feedback.
 * @param {string} [reason="Reason not specified"] - The reason for ending custom mode (for logging).
 * @returns {Promise<boolean>} True if custom mode was successfully ended (script ran), false otherwise.
 */
async function endCustomMode(initiatingObject, reason = "Reason not specified") {
    // Determine the context (Interaction, Message, or Channel) to send appropriate feedback
    let channel;
    let isInteraction = false;
    let isMessage = false;
    let feedbackMethod; // Function to send feedback (reply, followUp, send)

    if (initiatingObject.followUp && initiatingObject.channel) { // Likely an Interaction
        isInteraction = true;
        channel = initiatingObject.channel;
        // Use followUp if already replied/deferred, otherwise reply (ephemerally)
        feedbackMethod = async (options) => {
            try {
                const payload = typeof options === 'string' ? { content: options, ephemeral: true } : { ...options, ephemeral: true };
                if (initiatingObject.replied || initiatingObject.deferred) {
                    await initiatingObject.followUp(payload);
                } else {
                    await initiatingObject.reply(payload);
                }
            } catch (e) { console.error("[endCustomMode] Error sending interaction feedback:", e.code, e.message); }
        };
    } else if (initiatingObject.reply && initiatingObject.channel) { // Likely a Message
        isMessage = true;
        channel = initiatingObject.channel;
        // Reply directly to the message
        feedbackMethod = initiatingObject.reply.bind(initiatingObject);
    } else if (initiatingObject.send) { // Likely a Channel object (e.g., from timer)
        channel = initiatingObject;
        // Send a new message to the channel
        feedbackMethod = channel.send.bind(channel);
    } else {
        console.error("[Custom Mode] Could not determine context for endCustomMode. Cannot send feedback.");
        feedbackMethod = async () => {}; // No-op feedback if context unknown
    }

    console.log(`[Custom Mode] Attempting to end custom mode. Reason: ${reason}`);

    // --- Cleanup Timers and Intervals ---
    if (customModeTimerId) {
        clearTimeout(customModeTimerId);
        customModeTimerId = null;
        console.log("[Custom Mode] Cleared active custom mode timer.");
    }
    stopVlcTitleCheckInterval(); // Stop the VLC title checker
    // Delete any lingering prompt message
    if (stillWatchingPromptMessage) {
        await stillWatchingPromptMessage.delete().catch(e => console.warn("Could not delete final 'Still Watching?' prompt message:", e.message));
        stillWatchingPromptMessage = null;
    }

    // --- Check if Already Ended ---
    if (!isCustomModeActive) {
        console.log("[Custom Mode] End requested, but custom mode was already inactive.");
        await feedbackMethod({ content: "ℹ️ Custom mode is not currently active." }).catch(e => console.error("Error sending status:", e.code, e.message));
        return false; // Not active, nothing to end
    }

    // --- Execute Switch Back Script ---
    let scriptSuccess = false;
    try {
        console.log("[Custom Mode] Running 'switch back' AHK script...");
        const statusMsgContent = "⚙️ Attempting to switch back to the regular schedule via AHK script...";
        // Send status update (non-ephemeral if triggered by a command message like !ptv)
        await feedbackMethod(isInteraction ? { content: statusMsgContent } : statusMsgContent);

        // Run the AHK script configured to switch back
        await runAhkScript(customAhkPathBack, 'Switch Back Script');
        console.log("[Custom Mode] 'Switch back' AHK script executed successfully.");
        scriptSuccess = true;

        // --- Update State ---
        isCustomModeActive = false; // Set state flag *before* updating event name
        consecutiveSkipVotes = 0; // Reset consecutive skips

        // --- Send Success Feedback ---
        const successPayload = { content: "✅ Switched back to regular schedule." };
        // Use followUp for interactions if initial reply was ephemeral or deferred
        if (isInteraction && (initiatingObject.ephemeral || initiatingObject.deferred || initiatingObject.replied)) {
            await initiatingObject.followUp(successPayload).catch(e => console.error("Error sending success followUp:", e.code, e.message));
        } else {
            // Send reply or new message for command/channel context
            await feedbackMethod(successPayload).catch(e => console.error("Error sending success status:", e.code, e.message));
        }

    } catch (error) { // AHK Script execution failed
        console.error("[Custom Mode] Failed to execute 'switch back' AHK script.");
        scriptSuccess = false;
        // --- Send Error Feedback ---
        const errorPayload = { content: "⚠️ Failed to execute the AHK script to switch back. Custom mode remains active. Manual intervention may be needed." };
        // Use followUp for interactions if initial reply was ephemeral or deferred
        if (isInteraction && (initiatingObject.ephemeral || initiatingObject.deferred || initiatingObject.replied)) {
            await initiatingObject.followUp(errorPayload).catch(e => console.error("Error sending error followUp:", e.code, e.message));
        } else {
            await feedbackMethod(errorPayload).catch(e => console.error("Error sending error status:", e.code, e.message));
        }
        // NOTE: We do NOT change isCustomModeActive here because the script failed.
        //       Consider if the VLC interval should be restarted? For now, it remains stopped.
    }

    // --- Update Event Name (if script succeeded) ---
    if (scriptSuccess) {
        const currentShow = getCurrentShowTitle(); // Get the title for the current time slot
        if (currentShow && targetVoiceChannel) {
            console.log(`[Custom Mode] Updating event name back to scheduled show: "${currentShow}"...`);
            // Use internal helper to force update even if state change was recent
            await updateEventNameInternal(currentShow);
        } else {
            console.warn("[Custom Mode] Could not update event name back to schedule - no current show found or target channel missing.");
            // If we can't find a show, but the event still says "Custom Channel", set a default
            if (targetVoiceChannel && managedGuildEvent?.name.startsWith("Custom Channel")) {
                await updateEventNameInternal("Stream Starting Soon"); // Attempt to set a generic default
            }
        }
        console.log("[Custom Mode] Successfully ended custom mode. Resumed scheduled actions.");
        return true;
    } else {
         console.log("[Custom Mode] Script execution failed. Custom mode state NOT changed.");
         return false;
    }
}

// =============================================================================
// === Refresh Sequence Logic ===
// =============================================================================

/**
 * Executes the refresh sequence: updates event name (if applicable) and runs
 * the appropriate refresh AHK script based on whether custom mode is active.
 * Handles feedback for both Interaction and Message contexts.
 * @param {import('discord.js').Interaction | import('discord.js').Message} interactionOrMessage - The interaction or message triggering the refresh.
 */
async function executeRefreshSequence(interactionOrMessage) {
    const channel = interactionOrMessage.channel;
    const user = interactionOrMessage.user || interactionOrMessage.author;
    const userTag = user?.tag || 'Unknown User';
    const timestamp = `[${new Date().toLocaleString()}] REFRESH`;
    console.log(`${timestamp}: Refresh sequence triggered by ${userTag}.`);

    // Determine context and set up feedback methods
    const isInteraction = !!interactionOrMessage.followUp;
    let initialReplyMethod; // For the first reply/editReply
    let feedbackMethod;     // For subsequent followUps/edits/sends

    if (isInteraction) {
        // Ensure reply/deferral only happens once for interactions
        if (!interactionOrMessage.deferred && !interactionOrMessage.replied) {
            await interactionOrMessage.deferReply({ ephemeral: true }); // Refresh feedback is usually ephemeral
        }
        // Use editReply for the initial deferred message
        initialReplyMethod = async (options) => {
            try {
                await interactionOrMessage.editReply(typeof options === 'string' ? { content: options } : options);
            } catch (error) { console.error(`${timestamp} Error editing initial interaction reply:`, error.message); }
        };
        // Use followUp for any subsequent messages
        feedbackMethod = async (options) => {
            try {
                 await interactionOrMessage.followUp(typeof options === 'string' ? { content: options, ephemeral: true } : { ...options, ephemeral: true });
            } catch (error) { console.error(`${timestamp} Error sending interaction followUp:`, error.message); }
        };
    } else { // Assuming Message context
        let currentReplyMessage = null; // Keep track of the bot's reply to edit it
        // Send the initial reply to the command message
        initialReplyMethod = async (options) => {
            try {
                currentReplyMessage = await interactionOrMessage.reply(options);
            } catch (error) { console.error(`${timestamp} Error sending initial message reply:`, error.message); }
        };
        // Edit the bot's reply message, or send a new one if editing fails
        feedbackMethod = async (options) => {
            try {
                if (currentReplyMessage && currentReplyMessage.editable) {
                    await currentReplyMessage.edit(typeof options === 'string' ? { content: options } : options);
                } else if (channel) {
                    // Send a new message if the previous one isn't editable
                    currentReplyMessage = await channel.send(options);
                }
            } catch (error) { console.error(`${timestamp} Error sending/editing message feedback:`, error.message); }
        };
    }

    // --- Custom Mode Refresh ---
    if (isCustomModeActive) {
        console.log(`${timestamp}: Custom mode is active. Attempting to refresh CUSTOM stream.`);
        await initialReplyMethod("ℹ️ Custom Channel mode active. Refreshing custom stream...");

        // Check if the custom refresh script is configured and exists
        if (!customRefreshAhkPath || !fs.existsSync(customRefreshAhkPath)) {
            console.warn(`${timestamp}: Cannot execute custom refresh script - CUSTOM_REFRESH_AHK_SCRIPT_PATH not configured or file not found.`);
            await feedbackMethod(`⚠️ Cannot refresh custom stream: Custom refresh AHK script path not configured or file missing.`);
            return;
        }
        // Execute the custom refresh script
        try {
            console.log(`${timestamp}: Running custom refresh AHK script...`);
            await feedbackMethod(`⚙️ Executing custom stream refresh AHK script...`);
            await runAhkScript(customRefreshAhkPath, 'Custom Refresh Script');
            await feedbackMethod(`✅ Custom stream refresh AHK script executed.`);
        } catch (err) {
            console.error(`${timestamp}: Failed to execute custom refresh AHK script. Error details logged above.`);
            await feedbackMethod(`❌ Failed to execute custom stream refresh AHK script. Check console logs.`);
        }
        // Trigger a VLC title check shortly after the refresh attempt
        if (isCustomModeActive) {
            setTimeout(checkAndUpdateVlcEventTitle, 1500); // Check title 1.5s after script attempt
        }
        console.log(`${timestamp}: Custom mode refresh sequence complete.`);
        return; // End here for custom mode
    }

    // --- Standard Mode Refresh ---
    console.log(`${timestamp}: Starting standard refresh sequence (scheduled mode)...`);
    await initialReplyMethod("🔄 Attempting standard refresh...");

    // 1. Update Event Name to match current schedule
    const currentEventName = getCurrentShowTitle();
    if (currentEventName && targetVoiceChannel) {
        console.log(`${timestamp}: Updating event name to current schedule: "${currentEventName}"...`);
        await feedbackMethod(`Updating event name to: **"${currentEventName}"**`);
        const eventUpdateSuccess = await updateEventName(currentEventName);
        if (!eventUpdateSuccess) {
            await feedbackMethod(`⚠️ Failed to update event name (check permissions/logs).`);
        }
    } else if (!targetVoiceChannel) {
        console.warn(`${timestamp}: Cannot update event name - target voice channel not configured/available.`);
        await feedbackMethod(`⚠️ Cannot update event name: Target voice channel not configured.`);
    } else { // No current show found
        console.warn(`${timestamp}: Cannot update event name - no current show title found in schedule.`);
        await feedbackMethod(`⚠️ Cannot update event name: No current show information found in schedule.`);
    }

    // 2. Execute Standard Refresh Script
    if (!refreshAhkPath || !fs.existsSync(refreshAhkPath)) {
        console.warn(`${timestamp}: Cannot execute schedule refresh script - REFRESH_AHK_SCRIPT_PATH not configured or file not found.`);
        await feedbackMethod(`⚠️ Cannot execute schedule refresh AHK script: Path not configured or file missing.`);
    } else {
        try {
            console.log(`${timestamp}: Running schedule refresh AHK script...`);
            await feedbackMethod(`⚙️ Executing schedule refresh AHK script...`);
            await runAhkScript(refreshAhkPath, 'Refresh Script');
            // script1Success = true; // Not strictly needed here unless more steps depend on it
            await feedbackMethod(`✅ Schedule refresh AHK script executed.`);
        } catch (err) {
            // script1Success = false;
            console.error(`${timestamp}: Failed to execute schedule refresh AHK script. Error details logged above.`);
            await feedbackMethod(`❌ Failed to execute schedule refresh AHK script. Check console logs.`);
        }
    }

    await feedbackMethod("🔄 Standard refresh sequence complete.");
    console.log(`${timestamp}: Standard refresh sequence complete.`);
}

// =============================================================================
// === YouTube Download Queue Processor ===
// =============================================================================

/**
 * Processes the next item in the `youtubeQueue`.
 * Handles downloading, progress updates, cancellation, subfolders, and error reporting.
 * Ensures only one download runs at a time using the `isYoutubeDownloadActive` flag.
 */
async function processYoutubeQueue() {
    const queueTimestamp = `[${new Date().toLocaleString()}] YT Queue`;

    // Exit if a download is already active or the queue is empty
    if (isYoutubeDownloadActive) {
        // console.log(`${queueTimestamp}: Download already active. Waiting.`); // Too verbose
        return;
    }
    if (youtubeQueue.length === 0) {
        // console.log(`${queueTimestamp}: Queue is empty.`); // Too verbose
        return;
    }

    // --- Start Processing ---
    isYoutubeDownloadActive = true;
    currentDownloadJob = youtubeQueue.shift(); // Get the next job from the front of the queue
    const { url, sourceChannel, user, subfolder: requestedSubfolder } = currentDownloadJob;
    currentYoutubeDownloadMessage = null; // Reset status message reference
    let latestEta = 'N/A';
    let latestPercent = '0%';
    let downloadSucceeded = false;
    currentAbortController = new AbortController(); // Create AbortController for cancellation
    const signal = currentAbortController.signal;
    let expectedFinalPath = null; // Store the predicted final path for cleanup
    let videoId = null;
    let usernameForCleanup = user.username.replace(/[<>:"/\\|?*]/g, '_'); // Basic sanitation for filename
    let finalDownloadPath = videoDownloadFolder; // Default download path
    let subfolderUsedName = null; // Store the name of the subfolder actually used
    let subfolderWarningSent = false; // Flag if user was warned about invalid subfolder

    // --- Validate Root Download Folder ---
    if (!videoDownloadFolder) {
        console.error(`${queueTimestamp}: VIDEO_DOWNLOAD_FOLDER not configured. Cannot process download for ${url}.`);
        isYoutubeDownloadActive = false; // Release lock
        currentDownloadJob = null;
        currentAbortController = null;
        setTimeout(processYoutubeQueue, 500); // Check queue again soon
         if (sourceChannel) {
            await sourceChannel.send(`❌ Cannot download video for ${user.tag} (URL: <${url}>). Reason: Bot admin has not configured the download folder.`).catch(e => console.error(`${queueTimestamp} Error sending config error message:`, e));
         }
        return;
    }

    try {
        // --- Determine and Validate Subfolder ---
        if (requestedSubfolder) {
            const sanitizedSubfolder = sanitizeSubfolderName(requestedSubfolder);
            if (sanitizedSubfolder) {
                const potentialPath = path.join(videoDownloadFolder, sanitizedSubfolder);
                try {
                    // Check if the path exists and IS a directory
                    const stats = await fsp.stat(potentialPath).catch(() => null);
                    if (stats && stats.isDirectory()) {
                        finalDownloadPath = potentialPath; // Use the subfolder path
                        subfolderUsedName = sanitizedSubfolder;
                        console.log(`${queueTimestamp}: Using valid subfolder: "${subfolderUsedName}" (Path: ${finalDownloadPath})`);
                    } else {
                        console.warn(`${queueTimestamp}: Requested subfolder "${sanitizedSubfolder}" (from "${requestedSubfolder}") not found or is not a directory. Defaulting to root folder.`);
                        subfolderWarningSent = true; // Flag to notify user later
                    }
                } catch (statError) {
                    // Errors during stat (e.g., permission denied) also mean we default to root
                    console.error(`${queueTimestamp}: Error checking subfolder path "${potentialPath}":`, statError);
                    subfolderWarningSent = true; // Flag to notify user later
                }
            } else {
                // Sanitization resulted in an empty/invalid name
                console.warn(`${queueTimestamp}: Invalid subfolder name provided after sanitization: "${requestedSubfolder}". Defaulting to root folder.`);
                subfolderWarningSent = true; // Flag to notify user later
            }
        }

        // --- Extract Video ID (for fallback naming/logging) ---
        // Basic extraction attempts
        try {
            const parsedUrl = new URL(url);
            if (url.includes('youtube.com/watch?v=')) { videoId = parsedUrl.searchParams.get('v'); }
            else if (url.includes('youtu.be/')) { videoId = parsedUrl.pathname.split('/').pop(); }
            else if (url.includes('youtube.com/shorts/')) { videoId = parsedUrl.pathname.split('/shorts/')[1]?.split('?')[0]; }
        } catch (urlParseError) { console.warn(`${queueTimestamp}: Could not parse URL to extract video ID: ${urlParseError.message}`); }

        if (!videoId) {
            console.warn(`${queueTimestamp}: Could not extract standard video ID from URL: ${url}. Generating fallback.`);
            videoId = `unknown_${Date.now().toString(36)}`; // Generate a somewhat unique ID
        } else {
            console.log(`${queueTimestamp}: Extracted Video ID: ${videoId}`);
        }

    } catch (e) { // Catch errors during initial setup (subfolder check, URL parse)
        console.error(`${queueTimestamp}: Error during initial URL/subfolder processing:`, e);
        videoId = `error_${Date.now().toString(36)}`; // Mark ID as error-derived
        finalDownloadPath = videoDownloadFolder; // Ensure default path on error
        subfolderWarningSent = true; // Assume subfolder failed if error occurred here
    }

    console.log(`${queueTimestamp}: Processing item for ${user.tag} (Username: ${usernameForCleanup}, VideoID: ${videoId}). URL: ${url}. Target Path: ${finalDownloadPath}. Queue length: ${youtubeQueue.length}`);

    // Clear any previous ETA update interval
    if (etaUpdateIntervalId) clearInterval(etaUpdateIntervalId); etaUpdateIntervalId = null;

    // --- Define Output Template for yt-dlp ---
    // Includes title (truncated), video ID, sanitized username, and extension.
    const outputTemplateRelative = `%(title).100s [%(id)s] [${usernameForCleanup}].%(ext)s`;

    // --- Determine Expected Filename (using yt-dlp --get-filename) ---
    // This helps with cleanup if the download is cancelled partway through.
    try {
        console.log(`${queueTimestamp}: Getting expected filename in "${finalDownloadPath}" for URL ${url}...`);
        // Ensure the target download folder exists before trying to get the filename within it
        // (yt-dlp might need it for path resolution in some cases)
        if (!fs.existsSync(finalDownloadPath)) {
            try {
                await fsp.mkdir(finalDownloadPath, { recursive: true });
                console.log(`${queueTimestamp}: Created download folder: ${finalDownloadPath}`);
            } catch (mkdirErr) {
                console.error(`${queueTimestamp}: Failed to create download folder '${finalDownloadPath}' before get-filename:`, mkdirErr);
                // Proceed, but filename prediction might fail or be inaccurate
            }
        }

        // Options for yt-dlp to just print the final filename
        const filenameOptions = {
            getFilename: true, // Equivalent to --get-filename
            output: outputTemplateRelative, // Use the same template
            paths: finalDownloadPath, // Specify the target directory
            mergeOutputFormat: 'mp4' // Assume mp4 for filename prediction if merging occurs
        };
        // Remove undefined/null options
        for (const key in filenameOptions) { if (filenameOptions[key] === undefined || filenameOptions[key] === null) { delete filenameOptions[key]; } }

        // Execute yt-dlp to get the filename
        const filenameOutputRaw = await ytDlpExec(url, filenameOptions).catch(err => {
            console.warn(`${queueTimestamp}: ytDlpExec failed during --get-filename attempt:`, err.stderr || err.message);
            return null; // Treat as failure to get filename
        });

        // Parse the output
        if (filenameOutputRaw && filenameOutputRaw.stdout && typeof filenameOutputRaw.stdout === 'string' && filenameOutputRaw.stdout.trim()) {
            expectedFinalPath = filenameOutputRaw.stdout.trim();
            console.log(`${queueTimestamp}: Predicted final file path: "${expectedFinalPath}"`);
        } else {
            console.warn(`${queueTimestamp}: Could not determine final filepath from --get-filename output. Constructing fallback path.`);
            // Construct a fallback path based on known info if --get-filename failed
            try {
                const safeBaseName = `Unknown Title [${videoId}] [${usernameForCleanup}]`.replace(/[<>:"/\\|?*]/g, '_').substring(0, 150);
                expectedFinalPath = path.join(finalDownloadPath, `${safeBaseName}.mp4`);
                console.warn(`${queueTimestamp}: Constructed fallback path for cleanup: "${expectedFinalPath}"`);
            } catch (fallbackError) {
                console.error(`${queueTimestamp}: Error constructing fallback path:`, fallbackError);
                expectedFinalPath = null; // Failed to construct fallback
            }
        }
    } catch (filenameError) {
        console.warn(`${queueTimestamp}: General error getting final filename/path beforehand:`, filenameError.message);
        expectedFinalPath = null; // Mark as unknown on error
    }

    // --- Send Initial Status Message (including subfolder warning if needed) ---
    let initialStatusText = `⏳ Download starting for ${user.tag}... (URL: <${url}>)`;
    if (subfolderUsedName) {
        initialStatusText += `\n   📁 Saving to subfolder: \`${subfolderUsedName}\``;
    } else if (subfolderWarningSent && requestedSubfolder) {
        // Notify user if their requested subfolder was invalid and we defaulted
        initialStatusText += `\n   ⚠️ Subfolder "${requestedSubfolder}" not found/invalid. Saving to main folder.`;
    }
    try {
        if (sourceChannel) {
            currentYoutubeDownloadMessage = await sourceChannel.send(initialStatusText);
        } else {
            console.warn(`${queueTimestamp}: Cannot send initial download status, source channel unavailable for URL: ${url}`);
        }
    }
    catch(sendError) {
        console.error(`${queueTimestamp}: Failed to send initial status message for ${url}: ${sendError.message}`);
        // Continue download attempt even if status message fails
    }

    // --- Start ETA Updater Interval ---
    // Only start if we successfully sent the initial message
    if (currentYoutubeDownloadMessage) {
        etaUpdateIntervalId = setInterval(async () => {
            // Stop interval if download finished, was cancelled, or message deleted
            if (!currentYoutubeDownloadMessage || !isYoutubeDownloadActive || downloadSucceeded || signal.aborted) {
                if (etaUpdateIntervalId) clearInterval(etaUpdateIntervalId);
                etaUpdateIntervalId = null;
                return;
            }
            try {
                // Fetch the message again to ensure it still exists and get current content
                const liveMessage = await sourceChannel?.messages.fetch(currentYoutubeDownloadMessage.id).catch(() => null);
                if (liveMessage) {
                    currentYoutubeDownloadMessage = liveMessage; // Update reference
                    // Construct updated status text
                    let updateText = `⏳ Downloading for ${user.tag}... (${latestPercent} complete, ETA: ${latestEta}) (URL: <${url}>)`;
                    // Keep subfolder info in the update message
                    if (subfolderUsedName) {
                        updateText += `\n   📁 Saving to subfolder: \`${subfolderUsedName}\``;
                    } else if (subfolderWarningSent && requestedSubfolder) {
                        updateText += `\n   ⚠️ Subfolder "${requestedSubfolder}" not found/invalid. Saving to main folder.`;
                    }
                    // Edit the message only if the content has changed (avoids rate limits)
                    if (liveMessage.content !== updateText) {
                        await liveMessage.edit(updateText);
                    }
                }
                else {
                    // Message was deleted or is inaccessible
                    console.log(`${queueTimestamp}: Status message ${currentYoutubeDownloadMessage?.id} deleted or inaccessible. Stopping ETA updates.`);
                    if (etaUpdateIntervalId) clearInterval(etaUpdateIntervalId);
                    etaUpdateIntervalId = null;
                    currentYoutubeDownloadMessage = null; // Clear reference
                }
            } catch (editError) {
                 // Ignore "Unknown Message" error (10008) as it means the message was deleted
                 if (editError.code !== 10008) {
                     console.warn(`${queueTimestamp}: Error updating ETA message ${currentYoutubeDownloadMessage?.id}:`, editError.message);
                 }
                 // Stop updates if message is unknown or other error occurs
                 if (etaUpdateIntervalId) clearInterval(etaUpdateIntervalId);
                 etaUpdateIntervalId = null;
                 currentYoutubeDownloadMessage = null;
            }
        }, YT_DOWNLOAD_ETA_UPDATE_INTERVAL_MS);
    }

    // --- Execute Download using yt-dlp-exec ---
    try {
        // Ensure the final download directory exists right before starting the download
        if (!fs.existsSync(finalDownloadPath)){
            try {
                await fsp.mkdir(finalDownloadPath, { recursive: true });
                console.log(`${queueTimestamp}: Successfully created download folder just before download: ${finalDownloadPath}.`);
            } catch (mkdirError) {
                console.error(`${queueTimestamp}: FATAL: Failed to create download folder '${finalDownloadPath}' immediately before download:`, mkdirError);
                // Throw a specific error to be caught and reported to the user
                throw new Error(`Failed to create download directory. Check bot permissions and path validity. (Original Error: ${mkdirError.message})`);
            }
        }

        // --- yt-dlp Options ---
        const options = {
            paths: finalDownloadPath, // Target directory for downloads
            output: outputTemplateRelative, // Filename template
            // Format selection: Prioritize 720p mp4, then 720p webm, then best 720p overall
            format: 'bestvideo[height<=?720][ext=mp4]+bestaudio[ext=m4a]/best[height<=?720][ext=mp4]/bestvideo[height<=?720][ext=webm]+bestaudio[ext=opus]/best[height<=?720][ext=webm]/best[height<=?720]',
            mergeOutputFormat: 'mp4', // Merge non-mp4 formats into mp4 if needed
            ffmpegLocation: ffmpegPath, // Specify path to ffmpeg (if configured)
            // Post Processor Arguments (PPA): Re-encode to H.264/AAC for wider compatibility
            // Using reasonable settings (fast preset, CRF 28 for decent quality/size ratio, 128k audio)
            // NOTE: Ensure your ffmpeg build supports libx264 and aac encoders.
            ppa: 'VideoConvertor:-c:v libx264 -preset fast -crf 28 -c:a aac -b:a 128k',
            progress: (d) => { // Callback for progress updates
                if (d.eta) latestEta = d.eta;
                if (d.percent) latestPercent = d.percent;
                // Note: This callback might fire very frequently. The interval timer handles less frequent Discord updates.
            },
            noWarnings: true, // Suppress yt-dlp warnings (can be noisy)
            retries: 3, // Retry downloads up to 3 times
            socketTimeout: 30, // Timeout for network operations (seconds)
            signal: signal // Pass the AbortController signal for cancellation
        };
        // Remove any options that are undefined/null/empty string
        for (const key in options) { if (options[key] === undefined || options[key] === null || String(options[key]).trim() === '') { delete options[key]; } }

        console.log(`${queueTimestamp}: Calling ytDlpExec(url, options) to save in "${finalDownloadPath}"...`);

        // --- Start the Download Process ---
        await ytDlpExec(url, options);

        // Check if the process completed successfully *but* was aborted during execution
        if (signal.aborted) {
            console.log(`${queueTimestamp}: Download process completed its execution, but the signal was aborted. Treating as cancelled.`);
            throw new Error("Download aborted during execution"); // Trigger cancellation handling in catch block
        }

        // --- Download Succeeded ---
        downloadSucceeded = true;
        console.log(`${queueTimestamp}: Successfully downloaded and processed ${url} for ${user.tag} into "${finalDownloadPath}"`);

        // Prepare success message
        let successMessage = `✅ Successfully downloaded video requested by ${user.tag}! (URL: <${url}>)`;
        if (subfolderUsedName) {
            successMessage += `\n   📁 Saved to subfolder: \`${subfolderUsedName}\``;
        }
        // Add link to file management if configured
        if (fileManagementUrl) {
            successMessage += `\nℹ️ You can manage downloaded files [here](${fileManagementUrl}).`;
        }

        // Update the status message or send a new one
        if (currentYoutubeDownloadMessage && currentYoutubeDownloadMessage.editable) {
            await currentYoutubeDownloadMessage.edit(successMessage).catch(e => console.error(`${queueTimestamp} Error editing final success message:`, e));
        } else if (sourceChannel) {
            await sourceChannel.send(successMessage).catch(e => console.error(`${queueTimestamp} Error sending final success message:`, e));
        }

    } catch (error) { // --- Handle Download Errors & Cancellation ---
        downloadSucceeded = false; // Ensure failure state

        // --- Cancellation Handling ---
        if (signal.aborted || error.message === "Download aborted during execution") {
            console.log(`${queueTimestamp}: Download for ${user.tag} (URL: ${url}) was CANCELLED.`);

            // --- Attempt File Cleanup ---
            // Try to delete partial files (.part, .ytdl) or the final file if it was created before cancellation.
            // Uses the `expectedFinalPath` determined earlier.
            if (expectedFinalPath && fs.existsSync(path.dirname(expectedFinalPath))) {
                 console.log(`${queueTimestamp}: Searching for incomplete/final files matching base name of "${path.basename(expectedFinalPath)}" in "${path.dirname(expectedFinalPath)}" for cleanup...`);
                 const dirPath = path.dirname(expectedFinalPath);
                 // Get the base name without extension for broader matching
                 const baseName = path.basename(expectedFinalPath, path.extname(expectedFinalPath));

                 try {
                     const filesInDir = await fsp.readdir(dirPath);
                     // Find files starting with the base name and ending with common partial extensions or the expected final name
                     const filesToDelete = filesInDir.filter(file =>
                         file.startsWith(baseName) &&
                         (file.endsWith('.part') || file.endsWith('.ytdl') || path.basename(file) === path.basename(expectedFinalPath))
                     );

                     if (filesToDelete.length > 0) {
                         console.log(`${queueTimestamp}: Found potential files for cleanup:`, filesToDelete);
                         for (const file of filesToDelete) {
                             const filePathToDelete = path.join(dirPath, file);
                             console.log(`${queueTimestamp}: Attempting deletion of cancelled file: "${filePathToDelete}"`);
                             await fsp.unlink(filePathToDelete).then(() => {
                                 console.log(`${queueTimestamp}: Successfully deleted cancelled file fragment '${filePathToDelete}'.`);
                             }).catch(unlinkErr => {
                                 // Ignore "File Not Found" errors, log others
                                 if (unlinkErr.code !== 'ENOENT') {
                                     console.error(`${queueTimestamp}: Failed to delete cancelled file fragment '${filePathToDelete}':`, unlinkErr);
                                 } else {
                                     console.log(`${queueTimestamp}: File '${filePathToDelete}' not found for deletion (already deleted?).`);
                                 }
                             });
                         }
                     } else {
                          console.log(`${queueTimestamp}: No matching temporary/final files found for cleanup based on expected path.`);
                     }
                 } catch(readDirErr) {
                      console.error(`${queueTimestamp}: Failed to read download directory "${dirPath}" for cleanup after cancellation:`, readDirErr);
                 }

            } else {
                console.warn(`${queueTimestamp}: Cannot attempt reliable file cleanup after cancellation because the expected path was not determined or its directory doesn't exist.`);
            }

            // Send cancellation confirmation message
            const cancelMessage = `🚫 Download cancelled by user request for ${user.tag}. (URL: <${url}>)`;
            if (currentYoutubeDownloadMessage && currentYoutubeDownloadMessage.editable) {
                await currentYoutubeDownloadMessage.edit(cancelMessage).catch(e => console.error(`${queueTimestamp} Error editing message on cancel:`, e));
            } else if (sourceChannel) {
                await sourceChannel.send(cancelMessage).catch(e => console.error(`${queueTimestamp} Error sending cancel message:`, e));
            }
        } else {
            // --- Handle Regular Download Errors ---
            console.error(`${queueTimestamp}: Error downloading/processing video for ${user.tag} (URL: ${url}) into "${finalDownloadPath}":`, error);

            // Attempt to parse common errors from yt-dlp/ffmpeg stderr for user-friendly feedback
            let errorDetails = error?.message || "Unknown error during download/processing.";
            if(error?.stderr){
                 const stderrLower = error.stderr.toLowerCase();
                 if (stderrLower.includes('unsupported url')) errorDetails = "Unsupported URL.";
                 else if (stderrLower.includes('video unavailable')) errorDetails = "Video unavailable (private, deleted, or region-locked?).";
                 else if (stderrLower.includes('fragment download failed')) errorDetails = "Download failed (network issue or video stream problem). Retrying might help.";
                 else if (stderrLower.includes('ffmpeg') && stderrLower.includes('not found')) errorDetails = "ffmpeg not found or error during post-processing. Check FFMPEG_PATH in .env and console logs.";
                 else if (stderrLower.includes('unknown encoder') || stderrLower.includes('encoder \'libx264\'')) errorDetails = "ffmpeg error during encoding: Required encoder (libx264 or aac) not available in your ffmpeg build.";
                 else if (stderrLower.includes('no such file or directory') && stderrLower.includes('ffmpeg')) errorDetails = "ffmpeg error: Input file missing during processing (download might have failed partially).";
                 else if (stderrLower.includes('invalid argument') || stderrLower.includes('unable to open for writing') || stderrLower.includes('permission denied')) errorDetails = "Failed to write file. Check download folder path/permissions in .env, or check for invalid characters in the video title.";
                 else if (stderrLower.includes('no space left on device')) errorDetails = "Disk space full on the server.";
                 else if (stderrLower.includes('http error 403: forbidden')) errorDetails = "Access denied (likely YouTube blocking the download).";
                 else if (stderrLower.includes('http error 429: too many requests')) errorDetails = "Rate limited by YouTube. Try again later.";
                 else if (stderrLower.includes('socket timeout')) errorDetails = "Network connection timed out during download.";
                 // Generic yt-dlp error capture
                 else if(stderrLower.includes('error:')) {
                     const match = error.stderr.match(/error: (.*)/i);
                     if(match && match[1]) errorDetails = `Download/Processing failed: ${match[1].substring(0, 150)}`; // Limit length
                 }
            } else if (error?.code === 'ENOENT') {
                // Error if yt-dlp or ffmpeg executables themselves weren't found
                errorDetails = `Executable not found (yt-dlp or ffmpeg?). Check YT_DLP_PATH/FFMPEG_PATH in .env or ensure they are in system PATH. (Details: ${error.message})`;
            } else if (error?.message?.includes("Failed to create download directory")) {
                // Catch the specific error thrown if mkdir failed just before download
                errorDetails = error.message;
            }

            // Send failure message
            const failMessage = `❌ Failed video download for ${user.tag}. (URL: <${url}>)\nReason: ${errorDetails} (Check bot console logs for full details)`;
            if (currentYoutubeDownloadMessage && currentYoutubeDownloadMessage.editable) {
                await currentYoutubeDownloadMessage.edit(failMessage).catch(e => console.error(`${queueTimestamp} Error editing status message on failure:`, e));
            } else if (sourceChannel) {
                await sourceChannel.send(failMessage).catch(e => console.error(`${queueTimestamp} Error sending failure status message:`, e));
            }
        }
    } finally {
        // --- Cleanup After Job (Success, Fail, or Cancel) ---
        if (etaUpdateIntervalId) { // Ensure ETA interval is cleared
            clearInterval(etaUpdateIntervalId);
            etaUpdateIntervalId = null;
        }
        // Release the download lock and clear current job state
        isYoutubeDownloadActive = false;
        currentYoutubeDownloadMessage = null;
        currentDownloadJob = null;
        currentAbortController = null;
        console.log(`${queueTimestamp}: Finished processing item for ${user.tag} (URL: ${url}). Triggering next queue check.`);
        // Check the queue again shortly to process the next item if available
        setTimeout(processYoutubeQueue, 500);
    }
}

// =============================================================================
// === Browse Feature Helper Functions ===
// =============================================================================

/**
 * Reads the contents of a specified directory relative to the base download folder.
 * Sorts items: directories first (alphabetical), then files (newest first by birthtime).
 * Includes security check to prevent path traversal.
 * @param {string} basePath - Absolute path to the root video download folder.
 * @param {string} relativePath - Relative path within the base path (e.g., "Movies/Action").
 * @returns {Promise<Array<{ name: string; isDirectory: boolean; birthtimeMs?: number }>>} Array of directory entries.
 * @throws {Error} If path is invalid, not found, inaccessible, or traversal is attempted.
 */
async function getDirectoryContents(basePath, relativePath) {
    const timestamp = `[${new Date().toLocaleString()}] BROWSE DIR`;
    // Clean the relative path (remove leading slashes)
    const cleanRelativePath = relativePath.replace(/^[/\\]+/, '');
    // Construct the full absolute path
    const absolutePath = path.join(basePath, cleanRelativePath);
    console.log(`${timestamp}: Reading directory: ${absolutePath} (Relative: '${cleanRelativePath || '/'}')`);

    // --- Security Check: Path Traversal ---
    // Ensure the resolved absolute path is still within the intended base download directory.
    const resolvedPath = path.resolve(absolutePath);
    const resolvedBasePath = path.resolve(basePath);
    if (!resolvedPath.startsWith(resolvedBasePath)) {
        console.error(`${timestamp}: SECURITY ALERT: Attempted path traversal detected! Requested: "${absolutePath}", Resolved: "${resolvedPath}", Base: "${resolvedBasePath}"`);
        throw new Error("Access denied: Invalid path specified.");
    }

    try {
        // Read directory entries (files and subdirectories)
        const dirents = await fsp.readdir(absolutePath, { withFileTypes: true });
        const directories = [];
        const files = [];

        // Process each entry
        for (const dirent of dirents) {
            if (dirent.isDirectory()) {
                directories.push({ name: dirent.name, isDirectory: true });
            } else if (dirent.isFile()) {
                // Check if the file extension is in our allowed video list
                const ext = path.extname(dirent.name).toLowerCase();
                if (VIDEO_EXTENSIONS.includes(ext)) {
                    try {
                        // Get file stats (like creation time) for sorting
                        const stats = await fsp.stat(path.join(absolutePath, dirent.name));
                        files.push({ name: dirent.name, isDirectory: false, birthtimeMs: stats.birthtimeMs });
                    } catch (statError) {
                        console.warn(`${timestamp}: Error getting stats for file "${dirent.name}":`, statError.message);
                        // Include the file even if stats failed, perhaps sort it differently
                        files.push({ name: dirent.name, isDirectory: false, birthtimeMs: 0 }); // Sort files with stat errors to the bottom/top
                    }
                }
            }
        }

        // --- Sorting ---
        // Sort directories alphabetically (case-insensitive)
        directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        // Sort files by creation date (newest first), handling missing birthtime
        files.sort((a, b) => (b.birthtimeMs || 0) - (a.birthtimeMs || 0));

        // Combine sorted lists (directories first, then files)
        return [...directories, ...files];

    } catch (err) {
        console.error(`${timestamp}: Error reading directory "${absolutePath}":`, err);
        // Provide more specific error messages based on common error codes
        if (err.code === 'ENOENT') {
            throw new Error(`Directory not found: '${cleanRelativePath || '/'}'`);
        } else if (err.code === 'EACCES') {
            throw new Error(`Permission denied accessing directory: '${cleanRelativePath || '/'}'`);
        }
        // Generic error for other issues
        throw new Error(`Error listing contents of directory: '${cleanRelativePath || '/'}'`);
    }
}

/**
 * Updates the browse session's view data (items, pages) based on the current
 * path and search query by reading the directory and applying filters.
 * @param {BrowseSessionData} sessionData - The browse session data object to update.
 * @returns {Promise<boolean>} True if the update was successful.
 * @throws {Error} Propagates errors from `getDirectoryContents`.
 */
async function updateBrowseSessionView(sessionData) {
    const timestamp = `[${new Date().toLocaleString()}] BROWSE UPDATE VIEW`;
    try {
        // 1. Get all items (directories and valid video files) in the current directory
        sessionData.allDirectoryItems = await getDirectoryContents(videoDownloadFolder, sessionData.currentPath);

        // 2. Filter items if a search query is active
        let itemsToShow = sessionData.allDirectoryItems;
        if (sessionData.searchQuery) {
            const queryLower = sessionData.searchQuery.toLowerCase();
            itemsToShow = itemsToShow.filter(item => item.name.toLowerCase().includes(queryLower));
            console.log(`${timestamp}: Applied search "${sessionData.searchQuery}" in "${sessionData.currentPath || '/'}". Found ${itemsToShow.length} matching items.`);
        } else {
            console.log(`${timestamp}: No search active. Found ${itemsToShow.length} items in "${sessionData.currentPath || '/'}".`);
        }

        // 3. Update session data with the filtered items and recalculated pagination
        sessionData.items = itemsToShow; // The filtered list for display
        sessionData.totalPages = Math.max(1, Math.ceil(itemsToShow.length / BROWSE_ITEMS_PER_PAGE)); // Ensure at least 1 page
        // Clamp currentPage within valid range (1 to totalPages)
        sessionData.currentPage = Math.min(Math.max(1, sessionData.currentPage), sessionData.totalPages);

        return true; // Indicate success
    } catch (error) {
        // Log the error and reset view state in session data
        console.error(`${timestamp}: Failed to update browse view for path "${sessionData.currentPath}" with search "${sessionData.searchQuery}":`, error);
        sessionData.items = []; // Clear items on error
        sessionData.allDirectoryItems = [];
        sessionData.totalPages = 1;
        sessionData.currentPage = 1;
        // Re-throw the error so the calling function can handle user feedback
        throw error;
    }
}

/**
 * Generates the Discord Embed and Action Rows (buttons) for the browse interface
 * based on the current state of the session data.
 * @param {BrowseSessionData} sessionData - The current browse session data.
 * @returns {{embeds: EmbedBuilder[], components: ActionRowBuilder[]}} The UI elements.
 */
function generateBrowseUI(sessionData) {
    const { items, currentPage, totalPages, currentPath, searchQuery } = sessionData;

    // --- Calculate items for the current page ---
    const startIndex = (currentPage - 1) * BROWSE_ITEMS_PER_PAGE;
    const endIndex = startIndex + BROWSE_ITEMS_PER_PAGE;
    const pageItems = items.slice(startIndex, endIndex); // Get items for the current page only

    // --- Generate Embed Description (List of items) ---
    let description = pageItems.map((item, index) => {
        const itemNumber = startIndex + index + 1; // Global item number
        // Escape markdown characters in filenames (like `*_~|\`) to prevent formatting issues
        const escapedName = item.name.replace(/([`*_~|\\])/g, '\\$1');
        const prefix = item.isDirectory ? '📁' : '📄'; // Use different icons for folders/files
        return `\`${itemNumber}.\` ${prefix} ${escapedName}`; // Format: "1. 📁 FolderName" or "2. 📄 FileName.mp4"
    }).join('\n');

    // Handle cases with no items
    if (items.length === 0) {
        description = searchQuery
            ? `No items found matching search query "${searchQuery}".`
            : (currentPath === '' ? 'The download directory is empty.' : 'This directory is empty.');
    } else if (pageItems.length === 0 && currentPage > 1) {
         // Should not happen if page clamping works, but as a fallback
        description = "Error: No items found on this page (try going back?).";
    }

    // --- Generate Embed ---
    let title = `📂 File Browser`;
    if (currentPath) {
        // Display relative path nicely, limit length if necessary
        const displayPath = `/${currentPath.replace(/\\/g, '/')}`.substring(0, 80) + (currentPath.length > 80 ? '...' : '');
        title += ` (${displayPath})`;
    }
    if (searchQuery) {
        title += ` [Search: "${searchQuery}"]`;
    }
    const embed = new EmbedBuilder()
        .setTitle(title.substring(0, 256)) // Limit title length
        .setDescription(description.substring(0, 4096)) // Limit description length
        .setFooter({ text: `Page ${currentPage}/${totalPages} | Session Timeout: ${BROWSE_TIMEOUT_MS / 60000}m` })
        .setColor(0x0099FF); // Blue color

    // --- Generate Action Rows (Buttons) ---
    const row1 = new ActionRowBuilder(); // Navigation Buttons
    const row2 = new ActionRowBuilder(); // Action Buttons

    // Navigation Buttons (Up, Previous, Next)
    row1.addComponents(
        new ButtonBuilder().setCustomId('browse_up').setLabel('Up').setStyle(ButtonStyle.Secondary).setEmoji('⬆️')
            .setDisabled(currentPath === ''), // Disable 'Up' if already at the root
        new ButtonBuilder().setCustomId('browse_prev').setLabel('Previous').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
            .setDisabled(currentPage <= 1), // Disable 'Previous' on page 1
        new ButtonBuilder().setCustomId('browse_next').setLabel('Next').setStyle(ButtonStyle.Secondary).setEmoji('➡️')
            .setDisabled(currentPage >= totalPages) // Disable 'Next' on the last page
    );

    // Action Buttons (Search, Select, Cancel)
    row2.addComponents(
        new ButtonBuilder().setCustomId('browse_search').setLabel('Search').setStyle(ButtonStyle.Primary).setEmoji('🔍'),
        new ButtonBuilder().setCustomId('browse_select').setLabel('Select Item (#)').setStyle(ButtonStyle.Success).setEmoji('🗳️')
            .setDisabled(items.length === 0), // Disable 'Select' if there are no items in the current view
        new ButtonBuilder().setCustomId('browse_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('✖️')
    );

    return { embeds: [embed], components: [row1, row2] };
}

/**
 * Starts the confirmation poll after a user selects a file in the browse interface.
 * Handles votes, timeout, AHK script execution on success, and cleanup.
 * @param {BrowseSessionData} sessionData - The browse session data.
 * @param {string} selectedFileName - The name of the file selected by the user.
 * @param {string} relativeFilePath - The full relative path of the selected file from the download root.
 * @param {import('discord.js').Message} browseMessage - The main browse message (used to find session, potentially delete).
 * @param {import('discord.js').Interaction} interaction - The interaction (ButtonInteraction from 'Select Item') that triggered the selection.
 */
async function startBrowseConfirmationPoll(sessionData, selectedFileName, relativeFilePath, browseMessage, interaction) {
    const timestamp = `[${new Date().toLocaleString()}] BROWSE POLL`;
    const channel = interaction.channel;
    const fullFilePath = path.join(videoDownloadFolder, relativeFilePath); // Absolute path for AHK
    const escapedSelectedFile = selectedFileName.replace(/([`*_~|\\])/g, '\\$1'); // Escape for display in Discord messages

    console.log(`${timestamp}: User ${interaction.user.tag} initiated selection poll for file: "${selectedFileName}" (Relative Path: "${relativeFilePath}")`);

    // --- Cleanup Previous Collectors ---
    // Ensure any previous input/poll collectors associated with *this specific browse session* are stopped.
    sessionData.browsePollCollector?.stop('new_poll_starting'); // Stop existing poll collector
    sessionData.browsePollMessage?.delete().catch(() => {}); // Delete old poll message
    sessionData.numberInputCollector?.stop('selection_made'); // Stop number input collector
    sessionData.searchInputCollector?.stop('selection_made'); // Stop search input collector

    // --- Poll Setup ---
    const pollStartTime = Date.now();
    const pollEndTime = pollStartTime + BROWSE_SELECT_POLL_TIMEOUT_MS;
    const pollDurationSeconds = Math.round(BROWSE_SELECT_POLL_TIMEOUT_MS / 1000);

    const pollRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('browse_select_poll_yes').setLabel('Yes, Play It!').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('browse_select_poll_no').setLabel('No, Cancel').setStyle(ButtonStyle.Danger)
    );
    let yesVotes = 0;
    let noVotes = 0;
    const votedUsers = new Set(); // Track users who have voted
    let browsePollUpdateIntervalId = null; // Interval ID for updating the poll timer display

    // Function to generate the poll message content with updated votes and time remaining
    const generateBrowsePollContent = (y, n) => {
        const timeLeftMs = pollEndTime - Date.now();
        // Display time left dynamically, or "(ended)" if time is up
        const timeLeftString = timeLeftMs > 0 ? ` (${Math.ceil(timeLeftMs / 1000)}s left)` : ' (ended)';
        return `**Poll: Play this file?**\n\`${escapedSelectedFile}\`\n*(Vote ends in ${pollDurationSeconds}s${timeLeftString})*\n\nCurrent Votes: Yes - ${y} | No - ${n}`;
    };

    try {
        // --- Send Poll Message ---
        const pollMessage = await channel.send({
            content: generateBrowsePollContent(0, 0),
            components: [pollRow]
        });
        sessionData.browsePollMessage = pollMessage; // Store reference

        // --- Poll Button Collector ---
        sessionData.browsePollCollector = pollMessage.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: BROWSE_SELECT_POLL_TIMEOUT_MS // Timeout for the poll
        });

        // --- Poll Timer Update Interval ---
        // Periodically edit the poll message to show the remaining time.
        browsePollUpdateIntervalId = setInterval(async () => {
            if (!pollMessage?.editable) { // Stop if message deleted or not editable
                if (browsePollUpdateIntervalId) clearInterval(browsePollUpdateIntervalId);
                browsePollUpdateIntervalId = null;
                return;
            }
            try {
                await pollMessage.edit({ content: generateBrowsePollContent(yesVotes, noVotes), components: [pollRow] });
            } catch (e) {
                if (e.code !== 10008) { // Ignore "Unknown Message" error
                    console.warn(`${timestamp} Error updating browse poll timer message ${pollMessage?.id}:`, e.message);
                } else { // Message deleted, stop interval
                    if (browsePollUpdateIntervalId) clearInterval(browsePollUpdateIntervalId);
                    browsePollUpdateIntervalId = null;
                }
            }
        }, 10000); // Update every 10 seconds

        // --- Handle Votes ---
        sessionData.browsePollCollector.on('collect', async poll_i => {
            await poll_i.deferUpdate(); // Acknowledge button press
            // Allow only one vote per user
            if (votedUsers.has(poll_i.user.id)) {
                // Maybe send an ephemeral message? For now, just ignore subsequent votes.
                // await poll_i.followUp({ content: "You've already voted!", ephemeral: true });
                return;
            }
            votedUsers.add(poll_i.user.id); // Record vote

            // Increment vote counts
            if (poll_i.customId === 'browse_select_poll_yes') yesVotes++;
            else noVotes++;

            // Update the poll message immediately with new vote counts
            try {
                if (pollMessage?.editable) {
                    await pollMessage.edit({ content: generateBrowsePollContent(yesVotes, noVotes), components: [pollRow] });
                }
            }
            catch(e) { console.warn(`${timestamp} Error updating browse poll message ${pollMessage.id} after vote:`, e.message); }
        });

        // --- Handle Poll End ---
        sessionData.browsePollCollector.on('end', async (collected, reason) => {
            // --- Stop the Timer Update Interval ---
            if (browsePollUpdateIntervalId) {
                clearInterval(browsePollUpdateIntervalId);
                browsePollUpdateIntervalId = null;
            }

            console.log(`${timestamp}: Browse selection poll for "${selectedFileName}" ended. Reason: ${reason}. Final Votes: Yes-${yesVotes}, No-${noVotes}`);
            // Try to fetch the final state of the poll message
            const finalPollMessage = await channel.messages.fetch(pollMessage.id).catch(() => null);
            // Get reference to the main browse button collector before clearing session data
            const mainButtonCollector = sessionData.buttonCollector;

            // --- Clear Poll State from Session ---
            // Important to do this even if the session might be deleted later by the main collector end handler
            if (activeBrowseSessions.has(browseMessage.id)) {
                 const currentSessionData = activeBrowseSessions.get(browseMessage.id);
                 currentSessionData.browsePollCollector = null;
                 currentSessionData.browsePollMessage = null;
            }

            // --- Process Poll Result ---
            if (yesVotes > noVotes) { // Poll Passed
                const successMsg = `✅ Poll passed! Attempting to open \`${escapedSelectedFile}\` via AHK... (Votes: Yes-${yesVotes}, No-${noVotes})`;
                // Update the poll message to show the result
                if(finalPollMessage?.editable) await finalPollMessage.edit({ content: successMsg, components: [] }).catch(()=>{});
                else await channel.send(successMsg).catch(()=>{}); // Send new if edit fails

                try {
                    console.log(`${timestamp}: Poll passed. Running AHK open script for: "${fullFilePath}"`);

                    // --- Update Event Name on Successful Poll ---
                    // Extract filename without extension for a cleaner event title
                    const fileNameForEvent = path.basename(selectedFileName, path.extname(selectedFileName));
                    await updateEventNameInternal(fileNameForEvent); // Update event name

                    // --- Run the AHK Script ---
                    const { stderr } = await runAhkScript(openFileAhkPath, 'Open File Script', fullFilePath);

                    // Check stderr for potential errors reported by the AHK script
                    // (This relies on the AHK script writing "error:" to stderr on failure)
                    if (stderr && stderr.toLowerCase().includes('error')) {
                        console.error(`${timestamp}: Open file AHK script reported an error: ${stderr}`);
                        const errorText = stderr.split(/error:/i)[1]?.trim() || 'Unknown script error';
                        // Inform the user the script failed
                        await interaction.followUp({ content: `❌ AHK script failed to open file. Script Error: ${errorText}`, ephemeral: true });
                        // Stop the main browse session collector, indicating script failure reason
                        if (mainButtonCollector && !mainButtonCollector.ended) mainButtonCollector.stop('selected_poll_passed_script_failed');
                    } else {
                        // Script executed successfully (or at least didn't report an error via stderr)
                        console.log(`${timestamp}: Open file AHK script executed successfully for "${selectedFileName}"`);
                        // Delete the original browse message interface now that a file is playing
                        await browseMessage.delete().catch(e => console.warn(`${timestamp} Could not delete main browse message ${browseMessage.id} after successful selection poll:`, e.message));
                        // Stop the main browse session collector successfully
                        if (mainButtonCollector && !mainButtonCollector.ended) mainButtonCollector.stop('selected_poll_passed');
                    }
                } catch (scriptError) { // Catch errors from runAhkScript itself (e.g., file not found, exec error)
                    console.error(`${timestamp}: Failed to execute open file AHK script for "${fullFilePath}":`, scriptError);
                    await interaction.followUp({ content: `❌ Failed to run the AHK script to open the file. Check bot console logs.`, ephemeral: true });
                    // Stop the main browse session collector, indicating script failure reason
                     if (mainButtonCollector && !mainButtonCollector.ended) mainButtonCollector.stop('selected_poll_passed_script_failed');
                }

            } else { // Poll Failed or Tied
                const failMsg = `❌ Poll failed or tied! File selection cancelled. (Votes: Yes-${yesVotes}, No-${noVotes})`;
                // Update poll message
                if(finalPollMessage?.editable) await finalPollMessage.edit({ content: failMsg, components: [] }).catch(()=>{});
                else await channel.send(failMsg).catch(()=>{});
                // Stop the main browse session collector, indicating poll failure reason
                if (mainButtonCollector && !mainButtonCollector.ended) mainButtonCollector.stop('selected_poll_failed');
            }

            // --- Disable Buttons on Final Poll Message ---
            // Regardless of outcome, try to disable the Yes/No buttons on the poll message after it ends.
            if (finalPollMessage && finalPollMessage.components.length > 0 && finalPollMessage.editable) {
                const disabledRows = finalPollMessage.components.map(row =>
                    ActionRowBuilder.from(row).setComponents(
                        row.components.map(c => ButtonBuilder.from(c).setDisabled(true))
                    )
                );
                await finalPollMessage.edit({ components: disabledRows }).catch(e => console.warn(`${timestamp} Could not disable components on ended browse poll message: ${e.message}`));
            }
        }); // End Poll Collector 'end' Handler
    } catch (pollSendError) { // Error sending the initial poll message
         console.error(`${timestamp}: Error sending browse confirmation poll message:`, pollSendError);
         await interaction.followUp({ content: "❌ Error starting the confirmation poll.", ephemeral: true });
         // Stop the main browse collector if the poll failed to even start
         const mainButtonCollector = sessionData.buttonCollector;
         if (mainButtonCollector && !mainButtonCollector.ended) mainButtonCollector.stop('poll_start_error');
    }
} // --- End startBrowseConfirmationPoll ---

// =============================================================================
// === Browse Feature Main Sequence ===
// =============================================================================

/**
 * Initiates the interactive file browsing sequence (!browse command).
 * Sets up the session, displays the UI, and handles user interactions
 * (navigation, search, selection) via button collectors.
 * @param {import('discord.js').Interaction | import('discord.js').Message} initiatingObject - The interaction or message that triggered the browse command.
 */
async function startBrowseSequence(initiatingObject) {
    const timestamp = `[${new Date().toLocaleString()}] BROWSE START`;
    const channel = initiatingObject.channel;
    const user = initiatingObject.user || initiatingObject.author; // Get user from Interaction or Message
    const userId = user?.id;
    const isInteraction = !!initiatingObject.followUp; // Check if it's an Interaction

    // --- Determine Reply Methods ---
    let replyMethod; // For the initial message send/edit
    let followUpMethod; // For subsequent ephemeral messages (prompts, errors)

    if (isInteraction) {
        // Defer the interaction if not already done. Browse interface is public.
        if (!initiatingObject.deferred && !initiatingObject.replied) {
            // Use ephemeral: false for the main browse message
            await initiatingObject.deferReply({ ephemeral: false });
        }
        // Use editReply to send the initial browse UI to the deferred reply
        replyMethod = initiatingObject.editReply.bind(initiatingObject);
        // Use followUp for subsequent messages (usually ephemeral)
        followUpMethod = initiatingObject.followUp.bind(initiatingObject);
    } else { // Message command context
        // Reply directly to the command message
        replyMethod = initiatingObject.reply.bind(initiatingObject);
        // Subsequent messages are new messages in the channel
        followUpMethod = channel.send.bind(channel);
    }

    // Basic validation
    if (!userId) {
        console.error(`${timestamp}: Could not determine user ID for browse sequence.`);
        await replyMethod("Error starting browse: Could not identify user.").catch(()=>{});
        return;
    }
    if (!channel) {
         console.error(`${timestamp}: Could not determine channel for browse sequence.`);
         // Cannot reply if channel is unknown
         return;
    }

    console.log(`${timestamp}: Browse sequence initiated by ${user?.tag || userId} in channel ${channel.id}.`);

    // --- Pre-checks ---
    // Ensure browse is only available in custom mode and required configs/scripts exist.
    if (!isCustomModeActive) {
        await followUpMethod({ content: "Browsing files is only available in Custom Channel mode.", ephemeral: true });
        return;
    }
    if (!videoDownloadFolder || !fs.existsSync(videoDownloadFolder)) {
        await followUpMethod({ content: "⚠️ Video download folder is not configured or accessible by the bot. Cannot browse files.", ephemeral: true });
        return;
    }
    // Check for the AHK script needed to actually *play* the selected file
    if (!openFileAhkPath || !fs.existsSync(openFileAhkPath)) {
        await followUpMethod({ content: "⚠️ The AHK script needed to open files (`OPEN_FILE_AHK_PATH`) is not configured or found. Cannot select files to play.", ephemeral: true });
        return;
    }

     // --- Session Setup ---
     let browseMessage; // Will hold the main browse message object
     // Use message ID as the session key later, but need a temporary unique ID first if interaction
     const tempSessionId = `${channel.id}-${userId}-${Date.now()}`;

     try {
         // --- Initial Session Data Structure ---
         /** @type {BrowseSessionData} */
         const initialSessionData = {
            items: [], // Items on the current page (filtered)
            allDirectoryItems: [], // All items in the current directory (unfiltered)
            currentPage: 1,
            totalPages: 1,
            currentPath: '', // Start at the root relative path
            searchQuery: null, // No initial search
            originalUser: userId, // Store who started the session
            interaction: null, // Store the last interaction for context
            // Collectors will be initialized as needed
            numberInputCollector: null,
            searchInputCollector: null,
            browsePollCollector: null,
            browsePollMessage: null,
            buttonCollector: null
         };
         activeBrowseSessions.set(tempSessionId, initialSessionData); // Store session data

         // --- Initial View Update ---
         // Read the root directory contents to populate the initial view
         await updateBrowseSessionView(initialSessionData);

         // --- Generate Initial UI ---
         const { embeds: initialEmbeds, components: initialComponents } = generateBrowseUI(initialSessionData);

         // --- Send Initial Browse Message ---
         // Use replyMethod (editReply for interaction, reply for message)
         // fetchReply is crucial to get the Message object back for collector setup
         browseMessage = await replyMethod({ embeds: initialEmbeds, components: initialComponents, fetchReply: true });

         // --- Update Session ID to Message ID ---
         // Use the actual message ID as the definitive key for the session map
         const messageId = browseMessage.id;
         if (tempSessionId !== messageId) {
             activeBrowseSessions.set(messageId, initialSessionData);
             activeBrowseSessions.delete(tempSessionId); // Remove temporary ID
         }
         console.log(`${timestamp}: Browse session started with message ID ${messageId}.`);

         // --- Main Button Collector Setup ---
         const buttonCollector = browseMessage.createMessageComponentCollector({
             componentType: ComponentType.Button,
             time: BROWSE_TIMEOUT_MS // Set the overall timeout for the browse session
         });
         initialSessionData.buttonCollector = buttonCollector; // Store collector reference in session data

         // --- Handle Button Clicks ---
         buttonCollector.on('collect', async i => {
             const currentSessionId = browseMessage.id; // Use message ID as the session key
             const sessionData = activeBrowseSessions.get(currentSessionId);
             const buttonTimestamp = `[${new Date().toLocaleString()}] BROWSE BTN ${i.customId}`;

             // --- Validations for Button Click ---
             if (!sessionData) { // Session might have timed out or been cancelled
                 console.warn(`${buttonTimestamp}: Interaction received but session data not found for ${currentSessionId}.`);
                 await i.reply({ content: "This browse session has ended or is no longer valid.", ephemeral: true });
                 return;
             }
             // Ensure the interaction is from the original user who started the session
             if (i.user.id !== sessionData.originalUser) {
                 await i.reply({ content: "This browse session belongs to someone else!", ephemeral: true });
                 return;
             }
             // Prevent interaction if a poll or input collector is already active for this session
             if (sessionData.numberInputCollector || sessionData.searchInputCollector || sessionData.browsePollCollector) {
                 console.log(`${buttonTimestamp}: Button clicked, but another input/poll collector is active for session ${currentSessionId}.`);
                 await i.reply({ content: "ℹ️ Please complete or cancel the current action (selecting number, searching, or poll) before using other buttons.", ephemeral: true });
                 return;
             }

             // Store the latest interaction object for potential use in feedback/context
             sessionData.interaction = i;
             console.log(`${buttonTimestamp}: Clicked by ${i.user.tag} in session ${currentSessionId}`);

             // --- Button Actions ---
             try {
                switch (i.customId) {
                    // --- Cancel Button ---
                    case 'browse_cancel':
                        await i.deferUpdate(); // Acknowledge click
                        console.log(`${buttonTimestamp}: User cancelled browse session ${currentSessionId}.`);
                        buttonCollector.stop('cancelled'); // Stop the main collector
                        // Cleanup handled by the 'end' event listener
                        return;

                    // --- Navigation: Up Directory ---
                    case 'browse_up':
                        await i.deferUpdate();
                        if (sessionData.currentPath === '') return; // Should be disabled, but safety check

                        console.log(`${buttonTimestamp}: Navigating up from "${sessionData.currentPath}".`);
                        sessionData.currentPath = path.dirname(sessionData.currentPath); // Go up one level
                        sessionData.searchQuery = null; // Clear search when changing directory
                        sessionData.currentPage = 1; // Reset to page 1 of the parent directory

                        // Update view and edit message
                        await updateBrowseSessionView(sessionData);
                        const { embeds: upEmbeds, components: upComponents } = generateBrowseUI(sessionData);
                        await browseMessage.edit({ embeds: upEmbeds, components: upComponents });
                        return;

                    // --- Navigation: Previous/Next Page ---
                    case 'browse_prev':
                    case 'browse_next':
                        await i.deferUpdate();
                        if (i.customId === 'browse_prev' && sessionData.currentPage > 1) {
                            sessionData.currentPage--;
                        } else if (i.customId === 'browse_next' && sessionData.currentPage < sessionData.totalPages) {
                            sessionData.currentPage++;
                        } else {
                            return; // Button was likely disabled, do nothing
                        }
                        console.log(`${buttonTimestamp}: Navigating to page ${sessionData.currentPage}/${sessionData.totalPages}.`);

                        // Regenerate UI for the new page and edit message
                        const { embeds: navEmbeds, components: navComponents } = generateBrowseUI(sessionData);
                        await browseMessage.edit({ embeds: navEmbeds, components: navComponents });
                        return;

                    // --- Action: Search ---
                    case 'browse_search':
                        await i.deferUpdate(); // Defer immediately before asking for input

                        // Send an ephemeral prompt asking for the search query
                        const promptMsgSearch = await i.followUp({
                            content: `🔍 Type your search query below (press Enter). Search applies to the current directory *only*. Expires in ${BROWSE_SEARCH_INPUT_TIMEOUT_MS / 1000}s. Type nothing to clear search.`,
                            ephemeral: true,
                            fetchReply: true // Need the message object to delete later
                        });

                        // Create a message collector to wait for the user's search term
                        const searchFilter = m => m.author.id === sessionData.originalUser && m.channel.id === i.channel.id;
                        sessionData.searchInputCollector = i.channel.createMessageCollector({
                            filter: searchFilter,
                            time: BROWSE_SEARCH_INPUT_TIMEOUT_MS,
                            max: 1 // Collect only one message
                        });

                        sessionData.searchInputCollector.on('collect', async msg => {
                            const query = msg.content.trim();
                            // Clean up user message and bot prompt
                            await msg.delete().catch(e => console.warn(`${buttonTimestamp} Failed to delete user search input message:`, e.message));
                            await promptMsgSearch.delete().catch(e => console.warn(`${buttonTimestamp} Failed to delete search prompt message:`, e.message));

                            // Re-fetch session data in case it changed/ended while waiting
                            const currentSessionData = activeBrowseSessions.get(currentSessionId);
                            if (!currentSessionData) return;

                            currentSessionData.searchInputCollector = null; // Clear collector reference

                            // Update search query and reset view
                            if (!query) {
                                console.log(`${buttonTimestamp}: Search cleared by empty input.`);
                                currentSessionData.searchQuery = null;
                            } else {
                                console.log(`${buttonTimestamp}: Search query set to: "${query}".`);
                                currentSessionData.searchQuery = query;
                            }
                            currentSessionData.currentPage = 1; // Go to first page of results

                            // Update the browse view based on the new search query
                            try {
                                await updateBrowseSessionView(currentSessionData);
                                const { embeds: searchEmbeds, components: searchComponents } = generateBrowseUI(currentSessionData);
                                await browseMessage.edit({ embeds: searchEmbeds, components: searchComponents });
                            } catch (error) { // Handle errors during directory reading/filtering
                                console.error(`${buttonTimestamp}: Error updating view after search:`, error);
                                await i.followUp({ content: `❌ Error applying search: ${error.message}`, ephemeral: true });
                                // Optionally clear search query on error?
                                // currentSessionData.searchQuery = null;
                            }
                        });

                        sessionData.searchInputCollector.on('end', async (collected, reason) => {
                            console.log(`${buttonTimestamp}: Search input collector for session ${currentSessionId} ended. Reason: ${reason}`);
                            // Ensure collector reference is cleared in session data
                            const currentSessionData = activeBrowseSessions.get(currentSessionId);
                            if (currentSessionData) {
                                currentSessionData.searchInputCollector = null;
                            }
                            // Notify user if timed out
                            if (reason === 'time') {
                                try {
                                    await i.followUp({ content: "⏰ Timed out waiting for search query.", ephemeral: true });
                                    await promptMsgSearch.delete().catch(()=>{}); // Clean up prompt on timeout
                                } catch(e) { console.warn(`${buttonTimestamp} Error handling search timeout followUp/delete:`, e.message); }
                            }
                        });
                        return; // End processing for search button click

                    // --- Action: Select Item (by Number) ---
                    case 'browse_select':
                        await i.deferUpdate(); // Defer before asking for number

                        // Calculate the range of valid item numbers on the *current page*
                        const pageStartIndex = (sessionData.currentPage - 1) * BROWSE_ITEMS_PER_PAGE;
                        const pageItemsCount = sessionData.items.slice(pageStartIndex, pageStartIndex + BROWSE_ITEMS_PER_PAGE).length;
                        const minValidNumber = pageStartIndex + 1;
                        const maxValidNumber = pageStartIndex + pageItemsCount;

                        // Check if there are actually items to select on this page
                        if (pageItemsCount === 0) {
                            await i.followUp({ content: "ℹ️ There are no items to select on this page.", ephemeral: true });
                            return;
                        }

                        // Send ephemeral prompt for item number
                        const promptMsgNumber = await i.followUp({
                            content: `🗳️ Type the number (\`${minValidNumber}-${maxValidNumber}\`) of the item you want to select/open. Expires in ${BROWSE_NUMBER_INPUT_TIMEOUT_MS / 1000}s.`,
                            ephemeral: true, fetchReply: true
                        });

                        // Create collector for the number input
                        const numberFilter = m => m.author.id === sessionData.originalUser && m.channel.id === i.channel.id;
                        sessionData.numberInputCollector = i.channel.createMessageCollector({
                             filter: numberFilter,
                             time: BROWSE_NUMBER_INPUT_TIMEOUT_MS,
                             max: 1
                        });

                        sessionData.numberInputCollector.on('collect', async msg => {
                            const numberInputStr = msg.content.trim();
                            const numberInput = parseInt(numberInputStr, 10);
                            // Clean up user input and prompt
                            await msg.delete().catch(e => console.warn(`${buttonTimestamp} Failed to delete user number input message:`, e.message));
                            await promptMsgNumber.delete().catch(e => console.warn(`${buttonTimestamp} Failed to delete number prompt message:`, e.message));

                            // Re-fetch session data
                            const currentSessionData = activeBrowseSessions.get(currentSessionId);
                            if(!currentSessionData) return;

                            currentSessionData.numberInputCollector = null; // Clear collector ref

                            // Validate the input number
                            if (isNaN(numberInput) || numberInput < minValidNumber || numberInput > maxValidNumber) {
                                await i.followUp({ content: `⚠️ Invalid number entered (\`${numberInputStr}\`). Please use a number between \`${minValidNumber}\` and \`${maxValidNumber}\`. Click 'Select Item' again to retry.`, ephemeral: true });
                                return;
                            }

                            // Get the selected item from the *filtered* items list using the global index
                            const selectedIndex = numberInput - 1; // Adjust to 0-based index
                            const selectedItem = currentSessionData.items[selectedIndex];

                            if (!selectedItem) {
                                // This shouldn't happen if validation is correct, but safety check
                                console.error(`${buttonTimestamp}: Selected index ${selectedIndex} was out of bounds for current items array! (Input: ${numberInput}, Min: ${minValidNumber}, Max: ${maxValidNumber}, Items: ${currentSessionData.items.length})`);
                                await i.followUp({ content: `⚠️ Internal error: Could not find the selected item data. Please try again.`, ephemeral: true });
                                return;
                            }

                            // --- Handle Directory Selection ---
                            if (selectedItem.isDirectory) {
                                console.log(`${buttonTimestamp}: User selected directory: "${selectedItem.name}"`);
                                // Update path, clear search, reset page
                                currentSessionData.currentPath = path.join(currentSessionData.currentPath, selectedItem.name);
                                currentSessionData.searchQuery = null;
                                currentSessionData.currentPage = 1;

                                try {
                                    // Update view for the new directory
                                    await updateBrowseSessionView(currentSessionData);
                                    const { embeds: dirEmbeds, components: dirComponents } = generateBrowseUI(currentSessionData);
                                    await browseMessage.edit({ embeds: dirEmbeds, components: dirComponents });
                                } catch (error) { // Handle errors entering the directory
                                    console.error(`${buttonTimestamp}: Error updating view after entering directory "${selectedItem.name}":`, error);
                                    await i.followUp({ content: `❌ Error entering directory: ${error.message}`, ephemeral: true });
                                    // Attempt to revert the path change on error
                                    currentSessionData.currentPath = path.dirname(currentSessionData.currentPath);
                                    try {
                                        // Try to refresh the view back to the parent directory
                                        await updateBrowseSessionView(currentSessionData);
                                        const { embeds: revertEmbeds, components: revertComponents } = generateBrowseUI(currentSessionData);
                                        await browseMessage.edit({ embeds: revertEmbeds, components: revertComponents });
                                    } catch (restoreError) {
                                         console.error(`${buttonTimestamp}: Error restoring view after directory entry error:`, restoreError);
                                         // Session might be in a bad state, maybe stop it?
                                         buttonCollector.stop('error_directory_select_revert');
                                    }
                                }
                                return; // End processing for directory selection
                            }

                            // --- Handle File Selection ---
                            else { // It's a file
                                console.log(`${buttonTimestamp}: User selected file: "${selectedItem.name}"`);
                                const relativeFilePath = path.join(currentSessionData.currentPath, selectedItem.name);
                                // Start the confirmation poll
                                await startBrowseConfirmationPoll(currentSessionData, selectedItem.name, relativeFilePath, browseMessage, i);
                                // The poll function will now handle stopping the main collector appropriately.
                            }
                        }); // End Number Collector 'collect'

                        sessionData.numberInputCollector.on('end', async (collected, reason) => {
                            console.log(`${buttonTimestamp}: Number input collector for session ${currentSessionId} ended. Reason: ${reason}`);
                            const currentSessionData = activeBrowseSessions.get(currentSessionId);
                            if(currentSessionData) {
                                currentSessionData.numberInputCollector = null; // Clear collector ref
                            }
                            // Notify user on timeout
                            if (reason === 'time') {
                                try {
                                    await i.followUp({ content: "⏰ Timed out waiting for file number input.", ephemeral: true });
                                    await promptMsgNumber.delete().catch(()=>{}); // Clean up prompt
                                } catch(e) { console.warn(`${buttonTimestamp} Error handling number input timeout followUp/delete:`, e.message); }
                            }
                        }); // End Number Collector 'end'
                        return; // End processing for select button click

                    default:
                        console.warn(`${buttonTimestamp}: Received unknown button interaction ID: ${i.customId}`);
                        await i.reply({ content: "❓ Unknown button action.", ephemeral: true });
                } // End switch (i.customId)
             } catch (buttonError) {
                 // Catch errors during the button processing logic itself
                 console.error(`${buttonTimestamp}: Error processing button ${i.customId} in browse session ${currentSessionId}:`, buttonError);
                 try {
                     await i.followUp({ content: "❌ An internal error occurred while processing that button.", ephemeral: true });
                 } catch (followUpError) {
                     console.error(`${buttonTimestamp} Error sending follow-up for button processing error:`, followUpError);
                 }
             }
         }); // End Main Button Collector 'collect' Handler

         // --- Main Button Collector End Handler ---
         // This runs when the collector stops due to timeout, cancellation, selection, or error.
         buttonCollector.on('end', async (collected, reason) => {
             const currentSessionId = browseMessage.id; // Use message ID
             console.log(`${timestamp}: Browse main button collector for session ${currentSessionId} ended. Reason: ${reason}.`);
             const sessionData = activeBrowseSessions.get(currentSessionId); // Get data one last time

             // --- Cleanup Associated Collectors and Messages ---
             if (sessionData) {
                 // Stop any potentially active sub-collectors
                 sessionData.numberInputCollector?.stop('parent_ended');
                 sessionData.searchInputCollector?.stop('parent_ended');
                 sessionData.browsePollCollector?.stop('parent_ended'); // This also clears the poll timer interval inside its own 'end' handler

                 // Delete the poll message *unless* the session ended because of the poll result
                 // (in which case the poll message shows the outcome)
                 if (sessionData.browsePollMessage && !['selected_poll_passed', 'selected_poll_failed', 'selected_poll_passed_script_failed'].includes(reason)) {
                    await sessionData.browsePollMessage.delete().catch(()=>{});
                 }
             }

             // --- Remove Session from Map ---
             activeBrowseSessions.delete(currentSessionId);
             console.log(`${timestamp}: Removed browse session ${currentSessionId} from active sessions map.`);

             // --- Finalize Browse Message State ---
             // Fetch the message again to ensure it still exists
             const finalBrowseMessage = await channel?.messages.fetch(browseMessage.id).catch(() => null);
             if (!finalBrowseMessage) {
                console.log(`${timestamp}: Main browse message ${browseMessage.id} was already deleted or inaccessible.`);
                return;
             }

             // Decide final state based on end reason
             if (reason === 'cancelled') {
                 console.log(`${timestamp}: Deleting cancelled browse message ${browseMessage.id}`);
                 await finalBrowseMessage.delete().catch(e => console.warn(`${timestamp} Could not delete cancelled browse message: ${e.message}`));
             } else if (reason === 'selected_poll_passed') {
                 // Message should have been deleted by the successful poll logic already
                 console.log(`${timestamp}: Browse ended due to successful selection. Message ${browseMessage.id} should already be deleted.`);
             } else { // Timeout, poll failed, error, etc. -> Edit message to show ended state and disable buttons
                 if (finalBrowseMessage.editable) {
                     let finalContent = '**Browse Session Ended**'; // Default ended message
                     if (reason === 'time') finalContent = '**Browse Session Timed Out**';
                     else if (reason === 'selected_poll_failed') finalContent = '**File Selection Cancelled (Poll Failed/Tied)**';
                     else if (reason === 'selected_poll_passed_script_failed') finalContent = '**Selection Poll Passed, but AHK Script Failed**';
                     else if (reason.startsWith('error')) finalContent = '**Browse Session Ended Due to Error**';

                     console.log(`${timestamp}: Editing ended browse message ${browseMessage.id} (Reason: ${reason}) and disabling components.`);
                     try {
                        // Create disabled versions of all components
                        const disabledRows = finalBrowseMessage.components.map(row =>
                            ActionRowBuilder.from(row).setComponents(
                                row.components.map(c => ButtonBuilder.from(c).setDisabled(true))
                            )
                        );
                        // Edit message with final content and disabled buttons. Keep last embed for context.
                        await finalBrowseMessage.edit({ content: finalContent, embeds: finalBrowseMessage.embeds, components: disabledRows });
                     } catch(e) {
                          console.warn(`${timestamp} Could not disable components or edit ended browse message ${browseMessage.id}: ${e.message}`);
                          // As a fallback, maybe delete if edit fails? Or just leave it. Leaving it is safer.
                          // await finalBrowseMessage.delete().catch(()=>{});
                     }
                 } else {
                      console.log(`${timestamp}: Cannot edit final browse message ${browseMessage.id} (Reason: ${reason}) - not editable.`);
                 }
             }
         }); // End Main Button Collector 'end' Handler

     } catch (err) { // Catch errors during the *initial setup* of the browse sequence
         console.error(`${timestamp}: Error during browse sequence initial setup:`, err);
         const errorMsg = `❌ An error occurred while starting the file browser: ${err.message}`;
         // Try to send an ephemeral error message back to the user
         await followUpMethod({ content: errorMsg.substring(0, 1900), embeds: [], components: [], ephemeral: true }).catch(()=>{});

         // --- Cleanup on Setup Error ---
         const sessionKey = browseMessage?.id || tempSessionId; // Use message ID if available
         const session = activeBrowseSessions.get(sessionKey);
         if(session) {
             // Stop collector if it was somehow created before the error
             session.buttonCollector?.stop('error_setup');
             // Remove session from map
             activeBrowseSessions.delete(sessionKey);
             // Try to delete the initial browse message if it was created
             if(browseMessage?.deletable) await browseMessage.delete().catch(()=>{});
         }
     }
} // --- End startBrowseSequence ---


// =============================================================================
// === Bot Event Handlers ===
// =============================================================================

// --- Client Ready Event ---
// Executes once the bot successfully logs in and is ready.
client.once(Events.ClientReady, async (readyClient) => {
    console.log(`\n✅ Logged in as ${readyClient.user.tag}!`);
    client.user.setActivity('the TV Guide', { type: ActivityType.Watching }); // Set initial bot status

    let guildForEvent = null; // Store the Guild object for event management

    // --- Fetch and Validate Target Channels & Permissions ---
    console.log("--- Initializing Channels & Permissions ---");

    // TV Guide Post Channel
    if (tvGuideChannelId) {
        try {
            const channel = await readyClient.channels.fetch(tvGuideChannelId);
            if (channel && channel.isTextBased()) { // Ensure it's a text-based channel
                tvGuideTargetChannel = channel;
                console.log(`➡️ TV Guide Post Channel OK: #${channel.name} (ID: ${channel.id})`);
            } else {
                console.error(`➡️ TV Guide Post Channel Error: ID ${tvGuideChannelId} is not a valid text-based channel or not found.`);
                tvGuideTargetChannel = null;
            }
        } catch (err) {
            console.error(`➡️ TV Guide Post Channel Error: Failed fetching ID ${tvGuideChannelId}: ${err.message}`);
            tvGuideTargetChannel = null;
        }
    } else {
        console.log("➡️ TV Guide Post Channel: Not configured.");
    }

    // Scheduled Event Voice Channel
    if (targetVoiceChannelId) {
        try {
            const channel = await readyClient.channels.fetch(targetVoiceChannelId);
            if (channel && channel.type === ChannelType.GuildVoice) { // Ensure it's a voice channel
                targetVoiceChannel = channel;
                guildForEvent = channel.guild; // Get the guild from the channel
                console.log(`➡️ Event Voice Channel OK: #${channel.name} (ID: ${channel.id}) in Guild "${guildForEvent.name}"`);

                // Check Bot's Permissions in the specific Voice Channel
                const botMember = channel.guild.members.me; // The bot's GuildMember object
                const permsInChannel = channel.permissionsFor(botMember);
                if (!permsInChannel?.has(PermissionsBitField.Flags.ViewChannel)) {
                    console.warn(`   -> Event Channel Warning: Bot missing 'View Channel' permission for #${channel.name}.`);
                }
                if (!permsInChannel?.has(PermissionsBitField.Flags.Connect)) {
                    console.warn(`   -> Event Channel Warning: Bot missing 'Connect' permission for #${channel.name}.`);
                }
                // ManageEvents on the channel might be needed depending on server setup, but guild-wide is usually sufficient.
                if (!permsInChannel?.has(PermissionsBitField.Flags.ManageEvents)) {
                    console.warn(`   -> Event Channel Warning: Bot missing 'Manage Events' permission specifically for channel #${channel.name}. This might cause issues if guild-wide permission isn't granted.`);
                }

                // CRITICAL Check: Guild-wide Manage Events permission
                const guildPerms = botMember?.permissions; // Bot's permissions in the entire guild
                if (!guildPerms?.has(PermissionsBitField.Flags.ManageEvents)) {
                    console.error(`   -> FATAL ERROR: Bot lacks the server-wide 'Manage Events' permission in guild "${channel.guild.name}". Event functionality will be disabled.`);
                    targetVoiceChannel = null; // Disable event features
                    guildForEvent = null;
                } else {
                    console.log(`   -> Server-wide 'Manage Events' permission confirmed in "${channel.guild.name}".`);
                }
            } else {
                console.error(`➡️ Event Voice Channel Error: ID ${targetVoiceChannelId} is not a valid voice channel or not found.`);
                targetVoiceChannel = null;
                guildForEvent = null;
            }
        } catch (err) {
            console.error(`➡️ Event Voice Channel Error: Failed fetching ID ${targetVoiceChannelId}: ${err.message}`);
            targetVoiceChannel = null;
            guildForEvent = null;
        }
    } else {
        console.log("➡️ Event Voice Channel: Not configured.");
    }
    console.log("-------------------------------------------");

    // --- Initialize Discord Scheduled Event ---
    // Only proceed if the voice channel and guild were successfully identified and permissions are likely okay.
    if (targetVoiceChannel && guildForEvent) {
        console.log(`[Event Manager] Initializing scheduled event state for guild "${guildForEvent.name}"...`);
        managedGuildEvent = await findOrCreateManagedEvent(guildForEvent);
        if (managedGuildEvent) {
            console.log(`[Event Manager] Initialization complete. Managing event: "${managedGuildEvent.name}" (ID: ${managedGuildEvent.id})`);
            // Set the initial event name based on current mode/schedule
            const initialTitle = isCustomModeActive ? "Custom Channel" : getCurrentShowTitle();
            if (initialTitle) {
                console.log(`[Event Manager] Setting initial event name to "${initialTitle}"...`);
                await updateEventNameInternal(initialTitle); // Use internal to set correctly based on mode
            } else {
                console.log(`[Event Manager] No current show found in schedule for initial event name (or defaulting to Custom Channel if active). Using default.`);
                // If not custom mode, and no show, ensure a default like "Stream Starting Soon" if needed
                if (!isCustomModeActive) await updateEventNameInternal("Stream Starting Soon");
            }
        } else {
            console.error(`[Event Manager] Initialization failed. Could not find or create the managed event. Event features disabled.`);
            // Potentially disable targetVoiceChannel here if event creation is critical?
            // targetVoiceChannel = null;
        }
    }

    // --- Final Setup Steps ---
    setupCronJobs(); // Schedule the TV guide posts and event updates

    // // Start VLC checker IF custom mode happens to be true on startup
    // // (This would require persistence logic for isCustomModeActive across restarts)
    // if (isCustomModeActive) {
    //     console.log("[Ready Event] Custom mode is active on startup (assuming persisted state). Starting VLC check interval.");
    //     startVlcTitleCheckInterval();
    // }

    console.log('--------------------------------------------------');
    console.log(`Bot is Ready! Listening for commands prefixed with "${COMMAND_PREFIX}"`);
    console.log('--------------------------------------------------');
});


// --- Message Create Event ---
// Handles incoming messages and processes commands.
client.on(Events.MessageCreate, async (message) => {
    // Ignore messages from bots, DMs, or those not starting with the command prefix
    if (message.author.bot || !message.guild || !message.content.startsWith(COMMAND_PREFIX)) {
        return;
    }

    // Parse command and arguments
    const args = message.content.slice(COMMAND_PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const timestamp = `[${new Date().toLocaleString()}] CMD ${command}`;
    const userIsAdmin = isAdmin(message.member); // Check if the user has admin privileges

    // --- Command: !remote ---
    // Provides an interactive remote control via buttons.
    if (command === 'remote') {
        console.log(`${timestamp}: Received from ${message.author.tag} in #${message.channel.name}`);
        // Check user permissions (needed for admin buttons)
        const userPermissions = message.member?.permissions;
        if (!userPermissions) {
             console.warn(`${timestamp}: Could not get permissions for user ${message.author.tag}. Some buttons might be disabled unexpectedly.`);
             // Don't necessarily block, but admin buttons won't show if isAdmin check fails later
        }

        // --- Build Button Rows ---
        const rows = [];
        const topRow = new ActionRowBuilder(); // Always visible buttons
        const customRow1 = new ActionRowBuilder(); // Buttons related to custom mode actions
        const customRow2 = new ActionRowBuilder(); // Additional custom mode buttons (e.g., Browse)
        const adminRow = new ActionRowBuilder(); // Buttons restricted to admins

        // Top Row: Now Playing, Refresh, Schedule, Help
        topRow.addComponents(
            new ButtonBuilder().setCustomId('remote_now').setLabel('Now Playing').setStyle(ButtonStyle.Primary).setEmoji('📺'),
            new ButtonBuilder().setCustomId('remote_refresh').setLabel('Refresh Stream').setStyle(ButtonStyle.Danger).setEmoji('🔄')
                // Disable if the appropriate refresh script isn't configured (depends on mode)
                .setDisabled(!(isCustomModeActive ? (customRefreshAhkPath && fs.existsSync(customRefreshAhkPath)) : (refreshAhkPath && fs.existsSync(refreshAhkPath)))),
            new ButtonBuilder().setCustomId('remote_schedule').setLabel('View Schedule').setStyle(ButtonStyle.Secondary).setEmoji('📅'),
            new ButtonBuilder().setCustomId('remote_help').setLabel('Help').setStyle(ButtonStyle.Success).setEmoji('❓')
        );
        rows.push(topRow);

        // --- Custom Mode Rows (Conditional based on isCustomModeActive) ---
        // Check if required AHK scripts and configurations exist for enabling/disabling buttons
        const isCustomToScriptValid = !!customAhkPathTo && fs.existsSync(customAhkPathTo);
        const isCustomBackScriptValid = !!customAhkPathBack && fs.existsSync(customAhkPathBack);
        const isSkipScriptValid = !!skipCustomAhkPath && fs.existsSync(skipCustomAhkPath);
        const isDownloadConfigValid = !!videoDownloadFolder && fs.existsSync(videoDownloadFolder);
        const isFfmpegValid = !!ffmpegPath && fs.existsSync(ffmpegPath);
        const isOpenFileScriptValid = !!openFileAhkPath && fs.existsSync(openFileAhkPath);

        if (isCustomModeActive) {
            // Buttons available WHEN custom mode is ON
            customRow1.addComponents(
                new ButtonBuilder().setCustomId('remote_ptv').setLabel('Return to Schedule').setStyle(ButtonStyle.Secondary).setEmoji('⏪')
                    .setDisabled(!isCustomBackScriptValid), // Disable if back script missing
                new ButtonBuilder().setCustomId('remote_skipvote').setLabel('Skip Item (Vote)').setStyle(ButtonStyle.Danger).setEmoji('⏩')
                    .setDisabled(!isSkipScriptValid || !targetVoiceChannel), // Disable if skip script or VC missing
                new ButtonBuilder().setCustomId('remote_youtube').setLabel('Add Video (URL)').setStyle(ButtonStyle.Success).setEmoji('➕')
                    .setDisabled(!isDownloadConfigValid || !isFfmpegValid), // Disable if download/ffmpeg invalid
                new ButtonBuilder().setCustomId('remote_cancel').setLabel('Cancel My DLs').setStyle(ButtonStyle.Secondary).setEmoji('🗑️')
                    .setDisabled(!isDownloadConfigValid) // Disable if download folder invalid
            );
            // Add Admin "Cancel All Downloads" button if applicable
            if (userIsAdmin && isDownloadConfigValid) {
               customRow1.addComponents(
                    new ButtonBuilder().setCustomId('remote_cancelall').setLabel('Cancel All DLs').setStyle(ButtonStyle.Danger).setEmoji('💣')
                );
            }
             if (customRow1.components.length > 0) rows.push(customRow1);

            // Browse Files button
            customRow2.addComponents(
                 new ButtonBuilder().setCustomId('remote_browse').setLabel('Browse Files').setStyle(ButtonStyle.Primary).setEmoji('📂')
                    .setDisabled(!isDownloadConfigValid || !isOpenFileScriptValid) // Disable if download folder or open script invalid
            );
             if (customRow2.components.length > 0) rows.push(customRow2);

        } else { // Not in Custom Mode
            // Offer "Switch to Custom" button
            customRow1.addComponents(
                new ButtonBuilder().setCustomId('remote_custom').setLabel('Switch to Custom (Vote)').setStyle(ButtonStyle.Success).setEmoji('✨')
                    // Disable if either switch script or the voice channel is missing
                    .setDisabled(!isCustomToScriptValid || !isCustomBackScriptValid || !targetVoiceChannel)
            );
             if (customRow1.components.length > 0) rows.push(customRow1);
        }

        // --- Admin Row (Conditional) ---
        if (userIsAdmin) {
            // Check bot permissions in the *current channel* for the Clear button
            const botPermissionsInChannel = message.guild.members.me?.permissionsIn(message.channel);

            // Clear Bot Messages Button
            if (botPermissionsInChannel?.has(PermissionsBitField.Flags.ManageMessages) && botPermissionsInChannel?.has(PermissionsBitField.Flags.ReadMessageHistory)) {
                adminRow.addComponents(
                    new ButtonBuilder().setCustomId('remote_clear').setLabel('Clear Bot Msgs').setStyle(ButtonStyle.Secondary).setEmoji('🧹')
                );
            } else {
                console.warn(`${timestamp}: Admin button 'Clear Bot Msgs' hidden because bot lacks Manage Messages or Read History permission in #${message.channel.name}.`);
            }

            // Toggle Mode Button (Admin Override)
            adminRow.addComponents(
                new ButtonBuilder().setCustomId('remote_toggle').setLabel('Toggle Mode').setStyle(ButtonStyle.Primary).setEmoji('⚙️')
                    // Disable if scripts or VC missing (needed for state change effects)
                    .setDisabled(!isCustomToScriptValid || !isCustomBackScriptValid || !targetVoiceChannel)
            );
            if(adminRow.components.length > 0) rows.push(adminRow);
        }

        // --- Send Remote Message and Start Collector ---
        let remoteMessage = null;
        try {
            remoteMessage = await message.reply({
                content: `**Remote Control** (Buttons active for ${REMOTE_TIMEOUT_MS / 1000} seconds)`,
                components: rows,
            });
        } catch (err) {
            console.error(`${timestamp} Error sending !remote message:`, err);
            return; // Stop if message fails to send
        }

        // Collect button interactions on the remote message
        const collector = remoteMessage.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: REMOTE_TIMEOUT_MS // Timeout for the remote buttons
        });

        collector.on('collect', async i => {
            const buttonTimestamp = `[${new Date().toLocaleString()}] REMOTE BTN ${i.customId}`;

            // --- Permission Checks for Button Interaction ---
            const isAdminButton = ['remote_clear', 'remote_cancelall', 'remote_toggle'].includes(i.customId);
            const interactingUserIsAdmin = isAdmin(i.member); // Check if the *interacting* user is admin

            // Block non-admins from using admin buttons
            if (isAdminButton && !interactingUserIsAdmin) {
                await i.reply({ content: "You don't have permission to use this admin button.", ephemeral: true });
                return;
            }
            // Restrict non-admin buttons to the original command author
            if (!isAdminButton && i.user.id !== message.author.id) {
                 await i.reply({ content: "This remote control was initiated by someone else. Please use `!remote` yourself.", ephemeral: true });
                 return;
            }

            console.log(`${buttonTimestamp}: Clicked by ${i.user.tag}`);

            try {
                // --- Handle Different Button Actions ---
                // Defer non-modal interactions ephemerally for quick feedback
                if (i.customId !== 'remote_youtube') { // YouTube button opens a modal, handled differently
                   if (!i.deferred && !i.replied) {
                       await i.deferReply({ ephemeral: true });
                   }
                }
                // Note: For deferred replies, use i.editReply() for the first response,
                // and i.followUp() for any subsequent messages related to that interaction.

                switch (i.customId) {
                    // --- Now Playing Button ---
                    case 'remote_now': {
                        if (isCustomModeActive) {
                            await i.editReply("⏳ Fetching current VLC title (Windows only)...");
                            const vlcTitleRaw = await getVlcTitle();
                            if (vlcTitleRaw) {
                                // Clean title (remove extension) for display and event update
                                const extension = path.extname(vlcTitleRaw);
                                const baseName = path.basename(vlcTitleRaw, extension);
                                await i.editReply(`▶️ Now Playing (Custom Mode): **${baseName}**`);
                                await updateEventNameInternal(baseName); // Update event
                            } else {
                                await i.editReply("ℹ️ Custom Mode: Could not determine the currently playing title via VLC.");
                                // If event has a specific title but VLC doesn't, reset event to generic custom name
                                if(managedGuildEvent?.name.startsWith("Custom Channel:")) {
                                    await updateEventNameInternal("Custom Channel");
                                }
                            }
                        } else { // Standard Mode
                            const showData = getCurrentShowData();
                            const replyMessage = showData ? formatTvGuideMessage(showData) : "Nothing seems to be scheduled right now according to `schedule.js`.";
                            await i.editReply({ content: replyMessage });
                            // Also update event name in case it drifted from schedule
                            if (showData?.now) await updateEventName(showData.now.replace(/\*+/g, '').trim());
                        }
                        break;
                    } // End remote_now

                    // --- Refresh Button ---
                    case 'remote_refresh': {
                        // Feedback is handled within executeRefreshSequence
                        await i.editReply({ content: "🔄 Starting refresh sequence..." }); // Initial ack
                        await executeRefreshSequence(i); // Pass interaction object
                        break;
                    } // End remote_refresh

                    // --- Schedule Button ---
                    case 'remote_schedule': {
                        // Display schedule view options (Today, Week, Movies)
                        const scheduleRow = new ActionRowBuilder().addComponents(
                             new ButtonBuilder().setCustomId('remote_schedule_today').setLabel('Today').setStyle(ButtonStyle.Primary),
                             new ButtonBuilder().setCustomId('remote_schedule_week').setLabel('This Week').setStyle(ButtonStyle.Secondary),
                             new ButtonBuilder().setCustomId('remote_schedule_movies').setLabel("This Week's Movies").setStyle(ButtonStyle.Secondary)
                        );
                        // Edit the deferred reply to show the choice buttons
                        const scheduleChoiceMsg = await i.editReply({
                            content: "Choose a schedule view:",
                            components: [scheduleRow]
                        });

                        // Collector for the schedule choice buttons
                        const scheduleCollector = scheduleChoiceMsg.createMessageComponentCollector({
                            componentType: ComponentType.Button,
                            time: REMOTE_SCHEDULE_CHOICE_TIMEOUT_MS,
                            filter: interaction => interaction.user.id === i.user.id // Only original user
                        });

                        scheduleCollector.on('collect', async sched_i => {
                            // Defer differently based on expected response length (Week might need followUps)
                            if (sched_i.customId === 'remote_schedule_week') {
                                await sched_i.deferReply({ ephemeral: true }); // Defer ephemerally for potentially long output
                            } else {
                                await sched_i.deferUpdate(); // Update existing ephemeral message
                            }
                            const schedButtonTimestamp = `[${new Date().toLocaleString()}] REMOTE SCHED BTN ${sched_i.customId}`;
                            console.log(`${schedButtonTimestamp}: Schedule view '${sched_i.customId}' chosen by ${sched_i.user.tag}`);

                            try {
                                let scheduleContent = '';
                                let titlePrefix = '';
                                // --- Today's Schedule ---
                                if (sched_i.customId === 'remote_schedule_today') {
                                    titlePrefix = '--- Schedule for Today ---';
                                    const today = new Date().getDay();
                                    const daySchedule = schedule[today];
                                    const dayName = DAY_NAMES[today];
                                    let dayOutput = `**Schedule for ${dayName}:**\n`;
                                    let entriesFound = 0;
                                    if (!daySchedule || Object.keys(daySchedule).length === 0) {
                                        dayOutput += "No schedule found for today.";
                                    } else {
                                        const times = Object.keys(daySchedule).sort();
                                        for (const time of times) {
                                            const showData = daySchedule[time];
                                            // Only list standard 'now playing' entries
                                            if (showData && showData.now) {
                                                const formattedTime = formatTime12hr(time);
                                                const title = showData.now.replace(/\*+/g, '').trim(); // Clean title
                                                dayOutput += `${formattedTime} - ${title}\n`;
                                                entriesFound++;
                                            }
                                        }
                                        if (entriesFound === 0) { dayOutput += "No specific shows listed for today."; }
                                    }
                                    scheduleContent = `\`\`\`\n${titlePrefix}\n\n${dayOutput}\n\`\`\``;
                                    // Edit the ephemeral reply (or followUp if deferReply was used - though unlikely here)
                                    if (scheduleContent.length > EPHEMERAL_CONTENT_LIMIT) {
                                        console.warn(`${schedButtonTimestamp}: Today's schedule too long (${scheduleContent.length}). Truncating.`);
                                        await i.editReply({ content: scheduleContent.substring(0, EPHEMERAL_CONTENT_LIMIT - 20) + "\n... (Truncated)\n\`\`\`", components: [] });
                                    } else {
                                        await i.editReply({ content: scheduleContent, components: [] });
                                    }
                                    scheduleCollector.stop('selection_made'); // Stop collector after showing schedule
                                }
                                // --- Weekly Schedule ---
                                else if (sched_i.customId === 'remote_schedule_week') {
                                    console.log(`${schedButtonTimestamp}: Generating chunked weekly schedule...`);
                                    // Edit the initial deferral message
                                    await sched_i.editReply({ content: "Fetching weekly schedule (Mon-Sun)...", components: [] });
                                    let entriesFoundTotal = 0;
                                    const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Monday to Sunday
                                    for (const dayIndex of dayOrder) {
                                        const daySchedule = schedule[dayIndex];
                                        const dayName = DAY_NAMES[dayIndex];
                                        let dayOutput = '';
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
                                        // If entries were found for this day, send as a separate follow-up message
                                        if (entriesFoundThisDay > 0) {
                                            const scheduleChunk = `\`\`\`\n**${dayName}**\n${dayOutput}\n\`\`\``;
                                            entriesFoundTotal++;
                                            console.log(`${schedButtonTimestamp}: Prepared chunk for ${dayName}. Length: ${scheduleChunk.length}`);
                                            try {
                                                // Send chunk, truncate if necessary
                                                if (scheduleChunk.length > EPHEMERAL_CONTENT_LIMIT) {
                                                    console.warn(`${schedButtonTimestamp}: Weekly chunk for ${dayName} too long (${scheduleChunk.length}). Truncating.`);
                                                    await sched_i.followUp({ content: scheduleChunk.substring(0, EPHEMERAL_CONTENT_LIMIT - 20) + "\n... (Truncated)\n\`\`\`", ephemeral: true });
                                                } else {
                                                    await sched_i.followUp({ content: scheduleChunk, ephemeral: true });
                                                }
                                            } catch (followUpError) {
                                                console.error(`${schedButtonTimestamp}: Error sending schedule follow-up chunk for ${dayName}:`, followUpError);
                                                await sched_i.followUp({ content: `❌ Error sending schedule for ${dayName}.`, ephemeral: true}).catch(()=>{});
                                            }
                                        } else {
                                            console.log(`${schedButtonTimestamp}: No standard entries found for ${dayName}. Skipping chunk.`);
                                        }
                                    } // End loop through days
                                    if (entriesFoundTotal === 0) {
                                        console.log(`${schedButtonTimestamp}: No standard schedule entries found for the entire week.`);
                                        await sched_i.editReply({ content: "No standard schedule entries found for the entire week.", components: [] }).catch(()=>{}); // Edit the "Fetching..." message
                                    } else {
                                        console.log(`${schedButtonTimestamp}: Finished sending weekly schedule chunks.`);
                                        // Optionally edit the "Fetching..." message to say "Weekly schedule sent!"? Or just leave it.
                                    }
                                    scheduleCollector.stop('selection_made');
                                }
                                // --- Movie Listings ---
                                else if (sched_i.customId === 'remote_schedule_movies') {
                                    titlePrefix = '--- Movie Listings This Week (Mon-Sun) ---';
                                    let movieOutput = '';
                                    let moviesFound = 0;
                                    const moviePrefix = "MOVIE:"; // Assumes movies start with "MOVIE:" in schedule.js
                                    const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Monday to Sunday
                                    for (const dayIndex of dayOrder) {
                                        const daySchedule = schedule[dayIndex];
                                        if (!daySchedule) continue;
                                        const times = Object.keys(daySchedule).sort();
                                        for (const time of times) {
                                            const showData = daySchedule[time];
                                            // Check if 'now' field exists and starts with the movie prefix
                                            if (showData && showData.now && showData.now.trim().toUpperCase().startsWith(moviePrefix)) {
                                                const dayName = DAY_NAMES[dayIndex];
                                                const formattedTime = formatTime12hr(time);
                                                const movieTitle = showData.now.trim().substring(moviePrefix.length).trim(); // Extract title after prefix
                                                movieOutput += `${dayName}, ${formattedTime} - ${movieTitle}\n`;
                                                moviesFound++;
                                            }
                                        }
                                    }
                                    let scheduleOutput = moviesFound === 0
                                        ? "No entries marked with 'MOVIE:' found in the schedule for this week."
                                        : movieOutput;
                                    scheduleContent = `\`\`\`\n${titlePrefix}\n\n${scheduleOutput}\n\`\`\``;
                                    // Edit the ephemeral reply
                                    if (scheduleContent.length > EPHEMERAL_CONTENT_LIMIT) {
                                        console.warn(`${schedButtonTimestamp}: Movies schedule too long (${scheduleContent.length}). Truncating.`);
                                        await i.editReply({ content: scheduleContent.substring(0, EPHEMERAL_CONTENT_LIMIT - 20) + "\n... (Truncated)\n\`\`\`", components: [] });
                                    } else {
                                        await i.editReply({ content: scheduleContent, components: [] });
                                    }
                                    scheduleCollector.stop('selection_made');
                                }
                            } catch(schedError) {
                                console.error(`${schedButtonTimestamp}: Error processing schedule choice '${sched_i.customId}':`, schedError);
                                const errorReplyOptions = { content: "Sorry, an error occurred while fetching that schedule.", components: [] };
                                // Send error feedback appropriately (followUp if deferred for week, editReply otherwise)
                                if (sched_i.customId === 'remote_schedule_week' && (sched_i.replied || sched_i.deferred)) {
                                    await sched_i.followUp(errorReplyOptions).catch(() => {});
                                } else {
                                    await i.editReply(errorReplyOptions).catch(() => {}); // Edit the choice prompt
                                }
                                scheduleCollector.stop('error');
                            }
                        }); // End scheduleCollector 'collect'

                        scheduleCollector.on('end', async (collected, reason) => {
                            // Handle timeout for the schedule choice buttons
                            if (reason === 'time') {
                                console.log(`[REMOTE SCHED] Choice collector timed out for ${i.user.tag}`);
                                // Edit the choice prompt message to indicate timeout
                                await i.editReply({ content: "Schedule view choice timed out.", components: [] }).catch(() => {});
                            }
                            // Cleanup of buttons on the original choice message happens automatically if edited,
                            // or can be done here if needed (e.g., disable them explicitly). For ephemeral, less critical.
                        }); // End scheduleCollector 'end'
                        break; // Break from case 'remote_schedule'
                    } // End remote_schedule

                    // --- Help Button ---
                    case 'remote_help': {
                        let helpText = `**Basic Commands:**${commandList}\n**Custom Channel Only Commands:**${customModeCommandList}`;
                        // Add file management link if configured
                        if (fileManagementUrl) {
                            helpText += `\n\nℹ️ Custom Channel files (for !browse / VLC) can be managed [here](${fileManagementUrl}).`;
                        } else {
                            helpText += `\n\nℹ️ Ask an admin for the location/method to manage Custom Channel files.`
                        }
                        await i.editReply({ content: helpText.substring(0, EPHEMERAL_CONTENT_LIMIT) }); // Show help ephemerally
                        break;
                    } // End remote_help

                    // --- Switch to Custom Mode Button ---
                    case 'remote_custom': {
                        if (isCustomModeActive) {
                            await i.editReply({ content: "Custom Channel mode is already active." });
                            break;
                        }
                        // Redundant check as button should be disabled, but good practice
                        if (!customAhkPathTo || !customAhkPathBack || !fs.existsSync(customAhkPathTo) || !fs.existsSync(customAhkPathBack) || !targetVoiceChannel) {
                            await i.editReply({ content: "⚠️ Cannot start Custom mode: Required AHK scripts are not configured/found or target voice channel is missing." });
                            break;
                        }

                        // Start the poll (public message)
                        await i.editReply({ content: "Starting public poll to switch to Custom Channel..." }); // Update ephemeral reply

                        const pollRow = new ActionRowBuilder().addComponents(
                             new ButtonBuilder().setCustomId('custom_poll_yes').setLabel('Yes, Switch!').setStyle(ButtonStyle.Success),
                             new ButtonBuilder().setCustomId('custom_poll_no').setLabel('No, Stay on Schedule').setStyle(ButtonStyle.Danger)
                        );
                        let yesVotes = 0; let noVotes = 0; const votedUsers = new Set();
                        const pollDurationSeconds = Math.round(CUSTOM_POLL_TIMEOUT_MS / 1000);
                        const pollEndTime = Date.now() + CUSTOM_POLL_TIMEOUT_MS;
                        let pollUpdateIntervalId = null;

                        // Function to generate poll content with timer
                        const generatePollContent = (y, n) => {
                            const timeLeftMs = pollEndTime - Date.now();
                            const timeLeftString = timeLeftMs > 0 ? ` (${Math.ceil(timeLeftMs / 1000)}s left)` : ' (ended)';
                            return `**Poll: Switch to Custom Channel?**\n*(Vote ends in ${pollDurationSeconds} seconds${timeLeftString})*\n\nCurrent Votes: Yes - ${y} | No - ${n}`;
                        };

                        // Send the actual poll message
                        const pollMessage = await i.channel.send({ content: generatePollContent(0, 0), components: [pollRow] });

                        // Collector for poll votes
                        const customPollCollector = pollMessage.createMessageComponentCollector({ componentType: ComponentType.Button, time: CUSTOM_POLL_TIMEOUT_MS });

                        // Interval to update poll timer display
                        pollUpdateIntervalId = setInterval(async () => {
                            if (!pollMessage?.editable) { clearInterval(pollUpdateIntervalId); pollUpdateIntervalId = null; return; }
                            try { await pollMessage.edit({ content: generatePollContent(yesVotes, noVotes), components: [pollRow] }); }
                            catch(e) { if(e.code !== 10008) console.warn(`Error updating custom poll timer message ${pollMessage.id}:`, e.message); else { clearInterval(pollUpdateIntervalId); pollUpdateIntervalId = null;} }
                        }, 10000); // Update every 10s

                        // Handle votes
                        customPollCollector.on('collect', async poll_i => {
                            await poll_i.deferUpdate();
                            if (votedUsers.has(poll_i.user.id)) return; // One vote per user
                            votedUsers.add(poll_i.user.id);
                            if (poll_i.customId === 'custom_poll_yes') yesVotes++; else noVotes++;
                            // Update poll message immediately on vote
                            try { if (pollMessage?.editable) await pollMessage.edit({ content: generatePollContent(yesVotes, noVotes), components: [pollRow] }); }
                            catch(e) { if(e.code !== 10008) console.warn(`Error updating custom poll message after vote ${pollMessage.id}:`, e.message); }
                        });

                        // Handle poll end
                        customPollCollector.on('end', async (collected, reason) => {
                            if (pollUpdateIntervalId) { clearInterval(pollUpdateIntervalId); pollUpdateIntervalId = null; } // Stop timer interval
                            console.log(`${buttonTimestamp}: Switch to Custom poll ended. Reason: ${reason}. Final Votes: Yes-${yesVotes}, No-${noVotes}`);
                            let finalMessageContent = '';
                            const finalPollMessage = await i.channel.messages.fetch(pollMessage.id).catch(() => null); // Fetch final state
                            let pollPassed = yesVotes > noVotes;

                            if (pollPassed) { // Poll passed: Execute script, update state
                                finalMessageContent = `✅ Poll passed! Switching to Custom Channel mode... (Final Votes: Yes-${yesVotes}, No-${noVotes})`;
                                try { if (finalPollMessage?.editable) await finalPollMessage.edit({ content: finalMessageContent, components: [] }); }
                                catch (e) { console.warn(`Could not edit final custom poll message ${pollMessage.id} on success:`, e.message); }

                                try {
                                    const statusMsg = await i.channel.send(`⚙️ Executing AHK script to switch...`); // Public status message
                                    await runAhkScript(customAhkPathTo, 'Switch To Custom Script');
                                    // --- Update State on Success ---
                                    isCustomModeActive = true;
                                    console.log(`${buttonTimestamp}: Custom mode ENABLED via poll.`);
                                    consecutiveSkipVotes = 0; // Reset skip counter
                                    if (targetVoiceChannel) { await updateEventNameInternal("Custom Channel"); } // Update event name
                                    startCustomModeTimer(i.channel); // Start the 'Still Watching?' timer & VLC check

                                    // Edit status message to confirm success
                                    const successText = `▶️ Custom mode started successfully!`;
                                    const finalStatusMsg = await i.channel.messages.fetch(statusMsg.id).catch(()=>null);
                                    if(finalStatusMsg?.editable) await finalStatusMsg.edit(successText);
                                    else await i.channel.send(successText); // Send new if edit fails

                                } catch (scriptError) { // AHK Script failed
                                    pollPassed = false; // Mark as failed overall
                                    console.error(`${buttonTimestamp}: Failed to execute custom mode AHK script.`);
                                    const errorText = `❌ Failed to execute the AHK script to switch to custom mode. Custom mode remains OFF. Check console logs.`;
                                    await i.channel.send(errorText); // Public error message
                                    // Update original poll message to reflect script failure
                                    try { if (finalPollMessage?.editable) await finalPollMessage.edit({ content: `❌ Poll passed, but AHK script failed! Custom mode remains OFF. (Votes: Yes-${yesVotes}, No-${noVotes})`, components: [] }); }
                                    catch (e) { console.warn(`Could not edit final custom poll message after script error ${pollMessage.id}:`, e.message); }
                                }
                            } else { // Poll failed or tied
                                finalMessageContent = `❌ Poll failed or tied! Custom mode switch cancelled. (Final Votes: Yes-${yesVotes}, No-${noVotes})`;
                                try { if (finalPollMessage?.editable) await finalPollMessage.edit({ content: finalMessageContent, components: [] }); }
                                catch (e) { console.warn(`Could not edit final custom poll message ${pollMessage.id} on failure:`, e.message); }
                            }
                            // Disable buttons on the final poll message regardless of outcome
                            if (finalPollMessage && finalPollMessage.components.length > 0 && finalPollMessage.editable) {
                                const disabledRows = finalPollMessage.components.map(row => ActionRowBuilder.from(row).setComponents(row.components.map(c => ButtonBuilder.from(c).setDisabled(true))));
                                await finalPollMessage.edit({ components: disabledRows }).catch(e => console.warn(`Could not disable components on ended custom poll message ${pollMessage.id}: ${e.message}`));
                            }
                        }); // End customPollCollector 'end'
                        break; // Break from case 'remote_custom'
                    } // End remote_custom

                    // --- Return to Schedule Button ---
                    case 'remote_ptv': {
                        // Feedback handled within endCustomMode
                        await i.editReply({ content: "Okay, attempting to end Custom Channel mode and return to schedule..." }); // Ack ephemeral
                        await endCustomMode(i, `Remote button used by ${i.user.tag}`); // Pass interaction, reason; stops VLC interval inside
                        break;
                    } // End remote_ptv

                    // --- Skip Item Button ---
                    case 'remote_skipvote': {
                        if (!isCustomModeActive) { await i.editReply({ content: "Skipping only works during Custom Channel mode." }); break; }
                        const now = Date.now();
                        // Check cooldown
                        if (now < skipVoteCooldownEndTimestamp) {
                            const timeLeft = Math.ceil((skipVoteCooldownEndTimestamp - now) / 1000);
                            await i.editReply({ content: `Please wait ${timeLeft} more second(s) before starting another skip vote.` });
                            break;
                        }
                        // Check script config
                        if (!skipCustomAhkPath || !fs.existsSync(skipCustomAhkPath)) { await i.editReply({ content: "⚠️ The skip AHK script is not configured or file not found." }); break; }
                        if (!targetVoiceChannel) { await i.editReply({ content: "⚠️ Target voice channel not configured, cannot check member count for skip bypass." }); break; }

                        // --- Skip Bypass Check (2 users in VC) ---
                        try {
                            const currentVoiceChannel = await client.channels.fetch(targetVoiceChannelId);
                            if (currentVoiceChannel?.type === ChannelType.GuildVoice) {
                                const humanMembers = currentVoiceChannel.members.filter(m => !m.user.bot);
                                console.log(`${buttonTimestamp}: Checking VC (${currentVoiceChannel.name}) human members for skip bypass. Count: ${humanMembers.size}`);
                                if (humanMembers.size === 2) {
                                    console.log(`${buttonTimestamp}: VC has exactly 2 human members. Bypassing poll and running skip script.`);
                                    await i.editReply({ content: `⚙️ Only 2 users in voice chat. Bypassing poll and executing skip AHK script...` });
                                    try {
                                        await runAhkScript(skipCustomAhkPath, 'Skip Custom Item Script (Bypass)');
                                        consecutiveSkipVotes++; // Increment counter
                                        await i.followUp({ content: '✅ Skip AHK script executed (Bypass).', ephemeral: true });
                                        skipVoteCooldownEndTimestamp = Date.now() + SKIP_VOTE_COOLDOWN_MS; // Set cooldown
                                        setTimeout(checkAndUpdateVlcEventTitle, 1500); // Check title shortly after skip
                                    } catch (scriptError) {
                                        console.error(`${buttonTimestamp}: Failed to execute skip AHK script during bypass.`);
                                        await i.followUp({ content: `❌ Failed to execute the skip AHK script during bypass. Check logs.`, ephemeral: true });
                                        skipVoteCooldownEndTimestamp = Date.now() + SKIP_VOTE_COOLDOWN_MS; // Set cooldown even on failure
                                    }
                                    break; // Exit case 'remote_skipvote' after bypass attempt
                                }
                            } else { console.warn(`${buttonTimestamp}: Could not fetch target voice channel or it's not a voice channel. Proceeding with poll.`); }
                        } catch (fetchError) { console.error(`${buttonTimestamp}: Error fetching voice channel members for skip bypass check:`, fetchError); await i.editReply({ content: `⚠️ Error checking voice channel members. Proceeding with poll...` }); }

                        // --- Start Skip Poll ---
                        await i.editReply({ content: "Starting public poll to skip current item..." }); // Update ephemeral reply
                        skipVoteCooldownEndTimestamp = now + SKIP_VOTE_COOLDOWN_MS; // Start cooldown timer

                        // Calculate poll duration (decreases with consecutive skips, min duration applies)
                        const currentSkipPollTimeoutMs = Math.max(MIN_SKIP_POLL_DURATION_MS, SKIP_POLL_TIMEOUT_MS - (consecutiveSkipVotes * SKIP_POLL_DECREMENT_MS));
                        const skipPollDurationSeconds = Math.round(currentSkipPollTimeoutMs / 1000);
                        const skipPollEndTime = now + currentSkipPollTimeoutMs;
                        console.log(`${buttonTimestamp}: Starting skip poll. Consecutive skips: ${consecutiveSkipVotes}. Poll duration: ${skipPollDurationSeconds}s`);

                        const skipPollRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('skip_poll_yes').setLabel('Yes, Skip It!').setStyle(ButtonStyle.Danger),
                            new ButtonBuilder().setCustomId('skip_poll_no').setLabel('No, Keep Watching').setStyle(ButtonStyle.Success)
                        );
                        let yesVotes = 0; let noVotes = 0; const votedUsers = new Set();
                        let skipPollUpdateIntervalId = null;

                        // Function to generate poll content with timer
                        const generateSkipPollContent = (y, n) => {
                            const timeLeftMs = skipPollEndTime - Date.now();
                            const timeLeftString = timeLeftMs > 0 ? ` (${Math.ceil(timeLeftMs / 1000)}s left)` : ' (ended)';
                            return `**Poll: Skip current Custom Channel item?**\n*(Vote ends in ${skipPollDurationSeconds} seconds${timeLeftString})*\n\nCurrent Votes: Yes (Skip) - ${y} | No (Keep) - ${n}`;
                        };

                        // Send poll message
                        const skipPollMessage = await i.channel.send({ content: generateSkipPollContent(0, 0), components: [skipPollRow] });

                        // Collector for poll votes
                        const skipPollCollector = skipPollMessage.createMessageComponentCollector({ componentType: ComponentType.Button, time: currentSkipPollTimeoutMs });

                        // Interval to update timer
                        skipPollUpdateIntervalId = setInterval(async () => {
                            if (!skipPollMessage?.editable) { clearInterval(skipPollUpdateIntervalId); skipPollUpdateIntervalId = null; return; }
                            try { await skipPollMessage.edit({ content: generateSkipPollContent(yesVotes, noVotes), components: [skipPollRow] }); }
                            catch(e) { if(e.code !== 10008) console.warn(`Error updating skip poll timer message ${skipPollMessage.id}:`, e.message); else { clearInterval(skipPollUpdateIntervalId); skipPollUpdateIntervalId = null;} }
                        }, 10000); // Update every 10s

                        // Handle votes
                        skipPollCollector.on('collect', async skip_i => {
                            await skip_i.deferUpdate();
                            if (votedUsers.has(skip_i.user.id)) return; // One vote per user
                            votedUsers.add(skip_i.user.id);
                            if (skip_i.customId === 'skip_poll_yes') yesVotes++; else noVotes++;
                            try { if (skipPollMessage?.editable) await skipPollMessage.edit({ content: generateSkipPollContent(yesVotes, noVotes), components: [skipPollRow] }); }
                            catch(e) { if(e.code !== 10008) console.warn(`Error updating skip poll message after vote ${skipPollMessage.id}:`, e.message); }
                        });

                        // Handle poll end
                        skipPollCollector.on('end', async (collected, reason) => {
                            if (skipPollUpdateIntervalId) { clearInterval(skipPollUpdateIntervalId); skipPollUpdateIntervalId = null; } // Stop timer
                            console.log(`${buttonTimestamp}: Skip poll ended. Reason: ${reason}. Final Votes: Yes-${yesVotes}, No-${noVotes}`);
                            let finalSkipMessageContent = '';
                            const finalSkipPollMessage = await i.channel.messages.fetch(skipPollMessage.id).catch(() => null);
                            let pollPassed = yesVotes > noVotes;

                            if (pollPassed) { // Poll passed -> Run skip script
                                console.log(`${buttonTimestamp}: Skip poll PASSED. Executing skip AHK script.`);
                                consecutiveSkipVotes++; // Increment counter
                                console.log(`${buttonTimestamp}: Consecutive skips incremented to ${consecutiveSkipVotes}.`);
                                finalSkipMessageContent = `✅ Skip vote passed! Executing skip AHK script... (Final Votes: Yes-${yesVotes}, No-${noVotes})`;
                                try { if (finalSkipPollMessage?.editable) await finalSkipPollMessage.edit({ content: finalSkipMessageContent, components: [] }); }
                                catch (e) { console.warn(`Could not edit final skip poll message ${skipPollMessage.id} on pass:`, e.message); }

                                try {
                                    const skipStatusMsg = await i.channel.send(`⚙️ Executing skip AHK script...`); // Public status
                                    await runAhkScript(skipCustomAhkPath, 'Skip Custom Item Script');
                                    // Edit status message on success
                                    const finalSkipStatusMsg = await i.channel.messages.fetch(skipStatusMsg.id).catch(()=>null);
                                    if (finalSkipStatusMsg?.editable) await finalSkipStatusMsg.edit('✅ Skip AHK script executed successfully.');
                                    else await i.channel.send('✅ Skip AHK script executed successfully.');
                                    setTimeout(checkAndUpdateVlcEventTitle, 1500); // Check title after skip
                                } catch (scriptError) { // Script failed
                                    pollPassed = false; // Mark as failed overall
                                    console.error(`${buttonTimestamp}: Failed to execute skip AHK script after poll passed.`);
                                    consecutiveSkipVotes = 0; // Reset counter on script failure
                                    console.log(`${buttonTimestamp}: Consecutive skips reset due to script error.`);
                                    await i.channel.send(`❌ Failed to execute the skip AHK script. Check logs.`); // Public error
                                    // Update poll message to reflect script failure
                                    try { if (finalSkipPollMessage?.editable) await finalSkipPollMessage.edit({ content: `❌ Skip vote passed, but AHK script failed! (Votes: Yes-${yesVotes}, No-${noVotes})`, components: [] }); }
                                    catch (e) { console.warn(`Could not edit final skip poll message after script error ${skipPollMessage.id}:`, e.message); }
                                }
                            } else { // Poll failed or tied -> Reset counter
                                console.log(`${buttonTimestamp}: Skip poll FAILED or TIED. Skip cancelled.`);
                                consecutiveSkipVotes = 0; // Reset counter
                                console.log(`${buttonTimestamp}: Consecutive skips reset due to failed/tied vote.`);
                                if (yesVotes === 0 && noVotes === 0 && reason === 'time') finalSkipMessageContent = `⌛ Skip vote ended! No votes received. Nothing skipped.`;
                                else finalSkipMessageContent = `❌ Skip vote failed or tied! Nothing skipped. (Final Votes: Yes-${yesVotes}, No-${noVotes})`;
                                try { if (finalSkipPollMessage?.editable) await finalSkipPollMessage.edit({ content: finalSkipMessageContent, components: [] }); }
                                catch (e) { console.warn(`Could not edit final skip poll message ${skipPollMessage.id} on fail/tie:`, e.message); }
                            }
                            // Disable buttons on final poll message
                            if (finalSkipPollMessage && finalSkipPollMessage.components.length > 0 && finalSkipPollMessage.editable) {
                                const disabledRows = finalSkipPollMessage.components.map(row => ActionRowBuilder.from(row).setComponents(row.components.map(c => ButtonBuilder.from(c).setDisabled(true))));
                                await finalSkipPollMessage.edit({ components: disabledRows }).catch(e => console.warn(`Could not disable components on ended skip poll message ${skipPollMessage.id}: ${e.message}`));
                            }
                        }); // End skipPollCollector 'end'
                        break; // Break from case 'remote_skipvote'
                    } // End remote_skipvote

                    // --- Add YouTube Video Button ---
                    case 'remote_youtube': {
                        // This button opens a Modal, so no initial deferReply needed here.
                        if (!isCustomModeActive) { // Ensure custom mode is active (redundant check)
                            await i.reply({ content: "Adding videos via the remote button is only available in Custom Channel mode.", ephemeral: true });
                            break;
                        }
                        // Check download/ffmpeg config (redundant check)
                        if (!videoDownloadFolder) { await i.reply({ content: "⚠️ Video download folder is not configured by the bot admin.", ephemeral: true }); break; }
                        if (!ffmpegPath || !fs.existsSync(ffmpegPath)) { await i.reply({ content: "⚠️ Re-encoding downloaded videos requires `ffmpeg`, but FFMPEG_PATH is not configured or found.", ephemeral: true }); break; }

                        // --- Create and Show Modal ---
                        const modal = new ModalBuilder()
                            .setCustomId('youtube_url_subfolder_modal')
                            .setTitle('Add YouTube Video/Playlist');

                        const urlInput = new TextInputBuilder()
                            .setCustomId('youtube_url_input')
                            .setLabel("YouTube Video or Playlist URL")
                            .setStyle(TextInputStyle.Short) // Short for single line URL
                            .setRequired(true)
                            .setPlaceholder('https://www.youtube.com/watch?v=...');

                        const subfolderInput = new TextInputBuilder()
                            .setCustomId('youtube_subfolder_input')
                            .setLabel("Subfolder Name (Optional, within downloads)")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false) // Subfolder is optional
                            .setPlaceholder('e.g., Movies, MusicVideos, Favorites');

                        // Add inputs to the modal using Action Rows
                        modal.addComponents(
                            new ActionRowBuilder().addComponents(urlInput),
                            new ActionRowBuilder().addComponents(subfolderInput)
                        );

                        // Show the modal to the user who clicked the button
                        await i.showModal(modal);

                        // --- Await Modal Submission ---
                        let modalSubmitInteraction = null;
                        try {
                            // Wait for the user to submit the modal
                            modalSubmitInteraction = await i.awaitModalSubmit({
                                time: 120_000, // 2 minutes timeout for modal submission
                                // Filter ensures we only get the submission for *this* modal from *this* user
                                filter: submitInteraction => submitInteraction.customId === 'youtube_url_subfolder_modal' && submitInteraction.user.id === i.user.id
                            });

                            // Defer the reply to the modal submission ephemerally
                            await modalSubmitInteraction.deferReply({ ephemeral: true });

                            // Get the submitted values
                            const submittedUrl = modalSubmitInteraction.fields.getTextInputValue('youtube_url_input');
                            const submittedSubfolder = modalSubmitInteraction.fields.getTextInputValue('youtube_subfolder_input').trim() || null; // Get subfolder, null if empty/whitespace

                            console.log(`${buttonTimestamp}: User ${i.user.tag} submitted YouTube modal. URL: ${submittedUrl}, Subfolder: ${submittedSubfolder}`);

                            // Basic URL validation
                            if (!submittedUrl) { await modalSubmitInteraction.editReply("⚠️ No URL was provided."); break; }
                            try { new URL(submittedUrl); } // Check if it's a structurally valid URL
                            catch (_) { await modalSubmitInteraction.editReply("⚠️ That doesn't look like a valid URL."); break; }

                            // --- Process Submitted URL (Check for Playlist vs Single Video) ---
                            await modalSubmitInteraction.editReply(`🧐 Checking URL type (this may take a moment)...`);
                            try {
                                console.log(`${buttonTimestamp}: Performing preliminary check on URL with yt-dlp --print url: ${submittedUrl}`);
                                // Use yt-dlp to extract video URLs without downloading
                                const prelimOptions = {
                                    print: 'url', // Print video URLs only
                                    flatPlaylist: true, // Don't extract info for each video, just list URLs
                                    playlistItems: `1-${PLAYLIST_VIDEO_LIMIT + 5}`, // Limit check to avoid excessive API calls (check slightly more than limit)
                                    socketTimeout: 15 // Short timeout for this check
                                };
                                const prelimOutputRaw = await ytDlpExec(submittedUrl, prelimOptions);

                                let extractedUrls = [];
                                // yt-dlp-exec might return object or string, handle both
                                const prelimOutput = prelimOutputRaw.stdout || prelimOutputRaw;
                                if (prelimOutput && typeof prelimOutput === 'string' && prelimOutput.trim().length > 0) {
                                    // Split output by newline, trim, filter empty lines and the original playlist URL itself
                                    extractedUrls = prelimOutput.split('\n')
                                        .map(line => line.trim())
                                        .filter(line => line && line.startsWith('http') && line !== submittedUrl);
                                    console.log(`${buttonTimestamp}: Extracted ${extractedUrls.length} distinct video URLs using --print url.`);
                                } else {
                                    console.warn(`${buttonTimestamp}: Preliminary check (--print url) did not return expected string output or was empty. Output:`, prelimOutput);
                                    // Assume single video if extraction fails? Or error out? Proceeding as single video.
                                }

                                // Check if the original URL looks like an explicit playlist link
                                const isExplicitPlaylist = submittedUrl.includes('list=');

                                // --- Handle Playlist ---
                                // If it looks like a playlist AND we extracted multiple distinct URLs
                                if (isExplicitPlaylist && extractedUrls.length > 0) {
                                    console.log(`${buttonTimestamp}: Explicit playlist detected with ${extractedUrls.length} videos found.`);
                                    const urlsToQueue = extractedUrls.slice(0, PLAYLIST_VIDEO_LIMIT); // Apply limit
                                    const addedCount = urlsToQueue.length;
                                    const originalCount = extractedUrls.length; // Use actual extracted count for message

                                    // Prepare confirmation message
                                    let replyText = `▶️ Detected playlist! Adding ${addedCount} video(s) to the download queue`;
                                    if (originalCount > PLAYLIST_VIDEO_LIMIT) {
                                        replyText += ` (limited from ${originalCount} found).`;
                                    } else { replyText += `.`; }
                                    // Include subfolder info if provided
                                    if (submittedSubfolder) {
                                        replyText += `\n   📁 Target subfolder: \`${sanitizeSubfolderName(submittedSubfolder) || '(Invalid - Will use root)'}\``; // Show sanitized name preview
                                    }
                                    // Estimate starting queue position
                                    const startingPosition = (isYoutubeDownloadActive ? 1 : 0) + youtubeQueue.length + 1;
                                    replyText += ` Your downloads start around position: ${startingPosition}.`;
                                    await modalSubmitInteraction.editReply(replyText);

                                    // Add each video URL to the queue
                                    for (const videoUrl of urlsToQueue) {
                                        /** @type {YoutubeQueueItem} */
                                        const queueItem = { url: videoUrl, sourceChannel: i.channel, user: i.user, subfolder: submittedSubfolder };
                                        youtubeQueue.push(queueItem);
                                    }
                                    console.log(`${buttonTimestamp}: Added ${addedCount} videos from playlist. Subfolder: ${submittedSubfolder}. New queue length: ${youtubeQueue.length}`);
                                }
                                // --- Handle Single Video (or fallback) ---
                                else {
                                    console.log(`${buttonTimestamp}: Treating as single video.`);
                                    let editText = `➡️ Queuing single video...`;
                                    // If user provided subfolder
                                    if (submittedSubfolder) {
                                        editText += `\n   📁 Target subfolder: \`${sanitizeSubfolderName(submittedSubfolder) || '(Invalid - Will use root)'}\``;
                                    }
                                    await modalSubmitInteraction.editReply(editText);

                                    // Add the single URL (original submitted URL) to the queue
                                    /** @type {YoutubeQueueItem} */
                                    const queueItem = { url: submittedUrl, sourceChannel: i.channel, user: i.user, subfolder: submittedSubfolder };
                                    youtubeQueue.push(queueItem);
                                    console.log(`${buttonTimestamp}: Added single video ${submittedUrl} to queue. Subfolder: ${submittedSubfolder}. New queue length: ${youtubeQueue.length}`);
                                }
                                // Trigger the queue processor to start working if idle
                                setTimeout(processYoutubeQueue, 250);

                            } catch (prelimError) { // Error during the yt-dlp --print url check
                                console.error(`${buttonTimestamp}: Error during preliminary yt-dlp URL check:`, prelimError);
                                // Default to queueing as single video unless error indicates invalid URL
                                let errorText = `⚠️ Preliminary URL check failed (could not determine type). Attempting to queue as single video anyway...`;
                                let queueAsSingle = true;
                                if (prelimError?.stderr?.includes('is not a valid URL') || prelimError?.stderr?.includes('Unsupported URL')) {
                                    errorText = `❌ The provided URL is not valid or supported by yt-dlp: <${submittedUrl}>`;
                                    queueAsSingle = false;
                                } else if (prelimError?.stderr?.includes('Video unavailable')) {
                                    errorText = `⚠️ Video seems unavailable (private/deleted?), but adding to queue anyway...`;
                                }
                                // Include subfolder info in error message
                                if (submittedSubfolder) {
                                     errorText += `\n   📁 Target subfolder: \`${sanitizeSubfolderName(submittedSubfolder) || '(Invalid - Will use root)'}\``;
                                }
                                await modalSubmitInteraction.editReply(errorText);

                                // Queue as single if appropriate
                                if (queueAsSingle) {
                                    /** @type {YoutubeQueueItem} */
                                    const queueItem = { url: submittedUrl, sourceChannel: i.channel, user: i.user, subfolder: submittedSubfolder };
                                    youtubeQueue.push(queueItem);
                                    setTimeout(processYoutubeQueue, 250); // Trigger queue processing
                                }
                            } // End catch prelimError

                        } catch (modalError) { // Error awaiting modal submission (e.g., timeout)
                            if (modalError instanceof Collection && modalError.size === 0) { // Check if it's a timeout
                                console.log(`${buttonTimestamp}: YouTube URL/Subfolder modal timed out for user ${i.user.tag}.`);
                                // Send timeout message (no modalSubmitInteraction available here)
                                try { await i.followUp({ content: "⏰ Timed out waiting for YouTube URL submission.", ephemeral: true }); }
                                catch (followUpError) { console.warn(`${buttonTimestamp}: Could not send timeout follow-up for modal: ${followUpError.message}`); }
                            } else { // Other modal errors
                                console.error(`${buttonTimestamp}: Error awaiting modal submit:`, modalError);
                                try {
                                    // Try to reply to the interaction that initiated the modal or the submission itself
                                    const interactionToReply = modalSubmitInteraction || i;
                                    const errorContent = { content: "❌ An error occurred submitting the URL/Subfolder form.", ephemeral: true };
                                    // Check if interaction is still repliable
                                    if (interactionToReply && !interactionToReply.replied && !interactionToReply.deferred && interactionToReply.isRepliable()) {
                                        await interactionToReply.reply(errorContent);
                                    } else if (interactionToReply) { // Try followUp if already replied/deferred
                                        await interactionToReply.followUp(errorContent).catch(e => console.warn(`FollowUp failed for modal error (${e.code})`, e));
                                    } else { // Fallback if interaction object is lost
                                        console.warn(`${buttonTimestamp}: Interaction object was null in modal await catch. Cannot send direct feedback.`);
                                        if (channel) await channel.send({ content: `${user?.toString()} An error occurred submitting the YouTube URL form.` }).catch(()=>{});
                                    }
                                } catch (errorReportingError) {
                                    console.error(`!! Failed to report modal submission error back to user:`, errorReportingError);
                                }
                            }
                        } // End catch modalError
                        break; // End case 'remote_youtube'
                    } // End remote_youtube

                    // --- Clear Bot Messages Button (Admin) ---
                    case 'remote_clear': {
                        // Redundant permission check, already done for button visibility
                        if (!interactingUserIsAdmin) { break; }
                        // Check permissions again in case they changed
                        const botPermissions = i.guild?.members.me?.permissionsIn(i.channel);
                        if (!botPermissions?.has(PermissionsBitField.Flags.ManageMessages)) { await i.editReply({ content: "❌ I don't have the 'Manage Messages' permission in this channel anymore." }); break; }
                        if (!botPermissions?.has(PermissionsBitField.Flags.ReadMessageHistory)) { await i.editReply({ content: "❌ I don't have the 'Read Message History' permission needed to find messages anymore." }); break; }

                        await i.editReply({ content: `🧹 Fetching my messages from the last 12 hours in #${i.channel.name}...` });
                        const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
                        try {
                            // Fetch recent messages (limit 100 is max for fetch)
                            const fetchedMessages = await i.channel.messages.fetch({ limit: 100 });
                            // Filter for messages by the bot, within the time window, and not older than 14 days (bulk delete limit)
                            const messagesToDelete = fetchedMessages.filter(msg =>
                                msg.author.id === client.user.id &&
                                msg.createdTimestamp > twelveHoursAgo &&
                                (Date.now() - msg.createdTimestamp) < FOURTEEN_DAYS_MS // Ensure < 14 days old
                            );
                            const count = messagesToDelete.size;
                            console.log(`${buttonTimestamp}: Found ${count} message(s) by me in the last 12 hours eligible for deletion.`);

                            if (count === 0) {
                                await i.editReply({ content: "🧹 No messages from me found in the last 12 hours to delete." });
                            } else if (count === 1) {
                                await messagesToDelete.first().delete();
                                await i.editReply({ content: `✅ Successfully deleted 1 message.` });
                            } else { // Use bulk delete for 2 or more messages
                                const deletedMessages = await i.channel.bulkDelete(messagesToDelete, true); // true = filter out messages older than 14 days automatically
                                await i.editReply({ content: `✅ Successfully deleted ${deletedMessages.size} message(s).` });
                            }
                            // Optionally use followUp for final confirmation? editReply is fine.
                        } catch (error) {
                            console.error(`${buttonTimestamp}: Error during clear operation:`, error);
                            let errorText = "❌ An error occurred while trying to delete messages.";
                            if (error.code === 50034) { errorText += " (Cannot bulk delete messages older than 14 days)."; }
                            else if (error.code === 50013) { errorText += " (Missing Permissions?)."; }
                            await i.editReply({ content: `🧹 Clear operation finished with errors.` }).catch(()=>{});
                            await i.followUp({ content: errorText, ephemeral: true }).catch(e => console.error("Error sending clear error follow-up:", e));
                        }
                        break;
                    } // End remote_clear

                    // --- Cancel My Downloads Button ---
                    case 'remote_cancel': {
                        if (!isCustomModeActive) { await i.editReply({ content: "Downloads can only be cancelled in Custom Channel mode." }); break; }
                        if (!videoDownloadFolder) { await i.editReply("⚠️ Video downloads are not configured."); break; }

                        const userId = i.user.id;
                        let cancelledQueueCount = 0;
                        let activeCancelled = false;

                        // Check if the user's download is the currently active one
                        if (isYoutubeDownloadActive && currentDownloadJob?.user?.id === userId && currentAbortController) {
                            console.log(`${buttonTimestamp}: User ${i.user.tag} cancelling their active download: ${currentDownloadJob.url}`);
                            currentAbortController.abort(); // Trigger cancellation
                            activeCancelled = true;
                        }

                        // Filter the queue to remove pending items from this user
                        const initialQueueLength = youtubeQueue.length;
                        const newQueue = youtubeQueue.filter(job => job.user.id !== userId);
                        cancelledQueueCount = initialQueueLength - newQueue.length;

                        // Replace the old queue with the filtered one
                        youtubeQueue.length = 0; // Clear array in place
                        youtubeQueue.push(...newQueue); // Add remaining items back

                        console.log(`${buttonTimestamp}: User ${i.user.tag} cancelled ${cancelledQueueCount} pending item(s). Active download cancelled: ${activeCancelled}. New queue length: ${youtubeQueue.length}`);

                        // Formulate feedback message
                        let replyMessage = '';
                        if (activeCancelled && cancelledQueueCount > 0) { replyMessage = `🗑️ Cancelled your active download and removed ${cancelledQueueCount} pending item(s) from the queue.`; }
                        else if (activeCancelled) { replyMessage = `🗑️ Cancelled your active download. No other items were pending for you in the queue.`; }
                        else if (cancelledQueueCount > 0) { replyMessage = `🗑️ Removed ${cancelledQueueCount} pending item(s) from the queue. Your download was not the active one.`; }
                        else { replyMessage = `ℹ️ No active or pending downloads found for you to cancel.`; }

                        await i.editReply(replyMessage);
                        break;
                    } // End remote_cancel

                    // --- Cancel All Downloads Button (Admin) ---
                    case 'remote_cancelall': {
                        // Redundant checks
                        if (!interactingUserIsAdmin) { break; }
                        if (!isCustomModeActive) { await i.editReply({ content: "Downloads can only be cancelled in Custom Channel mode." }); break; }
                        if (!videoDownloadFolder) { await i.editReply("⚠️ Video downloads are not configured."); break; }

                        const initialQueueLength = youtubeQueue.length;
                        let activeCancelled = false;

                        // Cancel the active download if there is one
                        if (isYoutubeDownloadActive && currentAbortController) {
                            console.log(`${buttonTimestamp}: Admin ${i.user.tag} cancelling ALL downloads, including active: ${currentDownloadJob?.url}`);
                            currentAbortController.abort();
                            activeCancelled = true;
                        } else {
                            console.log(`${buttonTimestamp}: Admin ${i.user.tag} cancelling ALL pending downloads. No download was active.`);
                        }

                        // Clear the entire pending queue
                        youtubeQueue.length = 0;
                        console.log(`${buttonTimestamp}: Cleared ${initialQueueLength} pending items. Active cancelled: ${activeCancelled}. Queue is now empty.`);

                        await i.editReply(`💣 Cancelled ${activeCancelled ? 'the active download and ' : ''}${initialQueueLength} pending download(s). The queue is now empty.`);
                        break;
                    } // End remote_cancelall

                    // --- Toggle Mode Button (Admin) ---
                    case 'remote_toggle': {
                        // Redundant checks
                        if (!interactingUserIsAdmin) { break; }
                        if (!customAhkPathTo || !customAhkPathBack || !targetVoiceChannel) { await i.editReply("⚠️ Cannot toggle mode: Required AHK scripts or target voice channel not configured."); break; }

                        const newState = !isCustomModeActive;
                        console.log(`${buttonTimestamp}: Admin ${i.user.tag} toggling mode directly. Current State: ${isCustomModeActive}, New State: ${newState}`);
                        isCustomModeActive = newState; // Flip the state

                        if (isCustomModeActive) { // Toggled TO Custom Mode
                            console.log("[Toggle] Switched TO Custom Mode (No AHK Script Run).");
                            // Stop existing timer (if any) and start new one
                            if (customModeTimerId) clearTimeout(customModeTimerId);
                            startCustomModeTimer(i.channel); // Starts timer & VLC check interval
                            if (targetVoiceChannel) await updateEventNameInternal("Custom Channel"); // Update event
                            consecutiveSkipVotes = 0; // Reset skips
                            await i.editReply("⚙️ Toggled **TO** Custom Channel mode (AHK Scripts **NOT** run). Timer started, event updated.");
                        } else { // Toggled FROM Custom Mode
                            console.log("[Toggle] Switched FROM Custom Mode (No AHK Script Run).");
                            // Clear timer, stop VLC interval, delete prompt message
                            if (customModeTimerId) clearTimeout(customModeTimerId); customModeTimerId = null;
                            stopVlcTitleCheckInterval(); // Stop interval
                            if (stillWatchingPromptMessage) { await stillWatchingPromptMessage.delete().catch(e => console.warn("[Toggle] Could not delete 'Still Watching' prompt message:", e.message)); stillWatchingPromptMessage = null; }
                            // Update event name back to schedule
                            const currentShow = getCurrentShowTitle();
                            if (currentShow && targetVoiceChannel) await updateEventNameInternal(currentShow);
                            else if (targetVoiceChannel) await updateEventNameInternal("Stream Starting Soon"); // Default if no show
                            consecutiveSkipVotes = 0; // Reset skips
                            await i.editReply(`⚙️ Toggled **FROM** Custom Channel mode back to Schedule (AHK Scripts **NOT** run). Timer stopped, event updated.`);
                        }
                        break;
                    } // End remote_toggle

                    // --- Browse Files Button ---
                    case 'remote_browse': {
                        // Feedback is handled within startBrowseSequence
                        await i.editReply({ content: "🔄 Starting file browser..." }); // Ack ephemeral
                        await startBrowseSequence(i); // Pass the interaction object
                        // The browse sequence handles its own timeouts and cleanup.
                        break;
                    } // End remote_browse

                    // --- Default Case (Unknown Button) ---
                    default:
                        console.warn(`${buttonTimestamp}: Received unknown button interaction ID: ${i.customId}`);
                        await i.editReply({ content: "❓ Unknown button action." });
                } // End switch (i.customId)
            } catch (error) {
                // Generic error handler for button processing logic
                console.error(`${buttonTimestamp}: Error processing remote button '${i.customId}':`, error);
                try {
                    const errorContent = { content: '❌ Sorry, an error occurred while processing this button action.', components: [] };
                    // Try to send feedback using followUp or editReply depending on interaction state
                    if (i.replied || i.deferred) {
                         await i.followUp({ ...errorContent, ephemeral: true }).catch(e => console.warn(`Error sending followUp for button error (${e.code})`, e));
                    } else if (i.isRepliable()){
                        await i.reply({...errorContent, ephemeral: true }).catch(e => console.warn(`Error sending reply for button error (${e.code})`, e));
                    } else { // Fallback if interaction not repliable
                         if (i.channel) await i.channel.send({ content: `${i.user?.toString()} An error occurred processing the remote button.` }).catch(()=>{});
                    }
                } catch (errorReportingError) {
                    console.error(`!! Failed to report button processing error back to user:`, errorReportingError);
                }
            } // End try-catch for button processing
        }); // End collector.on('collect')

        collector.on('end', async (collected, reason) => {
            console.log(`${timestamp}: Remote control collector for ${message.author.tag} ended. Reason: ${reason}.`);
            // Fetch the remote message again to disable components or delete it
            const finalRemoteMessage = await message.channel.messages.fetch(remoteMessage.id).catch(() => null);
            if (!finalRemoteMessage) {
                console.log(`${timestamp}: Remote message ${remoteMessage.id} was already deleted or inaccessible.`);
                return;
            }

            // If timed out, delete the remote message
            if (reason === 'time') {
                console.log(`${timestamp}: Deleting timed out remote message ${remoteMessage.id}`);
                await finalRemoteMessage.delete().catch(e => console.warn(`${timestamp} Could not delete remote message on timeout: ${e.message}`));
            }
            // Otherwise (e.g., ended by an action, error), disable buttons
            else {
                if (finalRemoteMessage.components && finalRemoteMessage.components.length > 0 && finalRemoteMessage.editable) {
                    console.log(`${timestamp}: Disabling buttons on ended remote message ${remoteMessage.id}`);
                    const disabledRows = finalRemoteMessage.components.map(row => {
                        const newRow = ActionRowBuilder.from(row);
                        newRow.components.forEach(component => component.setDisabled(true));
                        return newRow;
                    });
                    try {
                        await finalRemoteMessage.edit({ content: '**Remote Control (Ended)**', components: disabledRows });
                    } catch (e) {
                        console.warn(`${timestamp} Could not disable components on ended remote message: ${e.message}`);
                    }
                } else {
                    console.log(`${timestamp}: Remote message ${remoteMessage.id} has no components, was deleted, or is not editable. Cannot disable components.`);
                }
            }
        }); // End collector.on('end')

    } // --- END !remote command ---

    // --- START Individual Command Handlers ---
    // (These mirror the functionality of the remote buttons but are invoked directly)

    // --- Command: !now ---
    else if (command === 'now') {
        console.log(`${timestamp}: Received from ${message.author.tag} in #${message.channel.name}`);
        if (isCustomModeActive) {
            const vlcTitleRaw = await getVlcTitle();
            if (vlcTitleRaw) {
                const extension = path.extname(vlcTitleRaw);
                const baseName = path.basename(vlcTitleRaw, extension);
                await message.reply(`▶️ Now Playing (Custom Mode): **${baseName}**`).catch(e=>console.error("Error replying to !now:", e));
                await updateEventNameInternal(baseName); // Update event
            } else {
                await message.reply("ℹ️ Custom Mode: Could not determine the currently playing title via VLC.").catch(e=>console.error("Error replying to !now:", e));
                 if(managedGuildEvent?.name.startsWith("Custom Channel:")) { // Reset event if no title found
                     await updateEventNameInternal("Custom Channel");
                }
            }
        } else { // Standard Mode
            const showData = getCurrentShowData();
            const replyMessage = showData ? formatTvGuideMessage(showData) : "Nothing seems to be scheduled right now according to `schedule.js`.";
            await message.reply(replyMessage).catch(e=>console.error("Error replying to !now:", e));
             // Also update event name in case it drifted
             if (showData?.now) await updateEventName(showData.now.replace(/\*+/g, '').trim());
        }
    }

    // --- Command: !refresh ---
    else if (command === 'refresh') {
         console.log(`${timestamp}: Received !refresh from ${message.author.tag} in #${message.channel.name}`);
         await executeRefreshSequence(message); // Pass message object, handles feedback internally
    }

          
	// --- Command: !schedule ---
    // Provides schedule view buttons (non-ephemeral response initially)
    else if (command === 'schedule') {
         console.log(`${timestamp}: Received from ${message.author.tag} in #${message.channel.name}`);
         // Schedule is irrelevant if custom mode is active
         if (isCustomModeActive) {
             await message.reply("The bot is currently in Custom Channel mode. The regular schedule is paused.").catch(e=>console.error("Error replying to !schedule:", e));
             return;
         }
         // Schedule view choice buttons (same as remote)
         const scheduleRow = new ActionRowBuilder().addComponents(
             new ButtonBuilder().setCustomId('cmd_schedule_today').setLabel('Today').setStyle(ButtonStyle.Primary),
             new ButtonBuilder().setCustomId('cmd_schedule_week').setLabel('This Week').setStyle(ButtonStyle.Secondary),
             new ButtonBuilder().setCustomId('cmd_schedule_movies').setLabel("This Week's Movies").setStyle(ButtonStyle.Secondary),
         );
         let initialMsg = null;
         try {
             // Send the button prompt (publicly) as a reply to the command
             initialMsg = await message.reply({ content: `Choose a schedule view: (Buttons active for ${REMOTE_TIMEOUT_MS / 1000}s)`, components: [scheduleRow] });
         } catch(e) { console.error(`${timestamp} Error sending schedule buttons:`, e); return; }

         // Collector for the schedule choice buttons on the reply message
         const collector = initialMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: REMOTE_TIMEOUT_MS });

         collector.on('collect', async i => {
             // Only allow the original command author to interact
             if (i.user.id !== message.author.id) {
                 await i.reply({ content: "This schedule selection isn't for you! Use `!schedule` yourself.", ephemeral: true });
                 return;
             }
             // Defer appropriately - Weekly view might send multiple messages, so defer ephemerally.
             // Today/Movie view will edit the original message, so deferUpdate is fine.
             if (i.customId === 'cmd_schedule_week') {
                 await i.deferReply({ ephemeral: true }); // Ephemeral for potentially multiple messages
             } else {
                 await i.deferUpdate(); // Acknowledge click, plan to edit the original message
             }
             const cmdButtonTimestamp = `[${new Date().toLocaleString()}] CMD SCHED BTN ${i.customId}`;
             console.log(`${cmdButtonTimestamp}: Schedule command button '${i.customId}' clicked by ${i.user.tag}`);

             try {
                 let scheduleContent = '';
                 let titlePrefix = '';
                 // --- Today's Schedule ---
                 if (i.customId === 'cmd_schedule_today') {
                     titlePrefix = '--- Schedule for Today ---';
                     const today = new Date().getDay(); // 0=Sun, 6=Sat
                     const daySchedule = schedule[today];
                     const dayName = DAY_NAMES[today];
                     let dayOutput = `**Schedule for ${dayName}:**\n`;
                     let entriesFound = 0;
                     if (!daySchedule || Object.keys(daySchedule).length === 0) {
                         dayOutput += "No schedule found for today.";
                     } else {
                         const times = Object.keys(daySchedule).sort(); // Sort times chronologically
                         for (const time of times) {
                             const showData = daySchedule[time];
                             // Only list standard 'now playing' entries from schedule
                             if (showData && showData.now) {
                                 const formattedTime = formatTime12hr(time); // Format HH:MM to h:mm AM/PM
                                 const title = showData.now.replace(/\*+/g, '').trim(); // Clean title (remove markdown)
                                 dayOutput += `${formattedTime} - ${title}\n`;
                                 entriesFound++;
                             }
                         }
                         if (entriesFound === 0) { dayOutput += "No specific shows listed for today."; }
                     }
                     scheduleContent = `\`\`\`\n${titlePrefix}\n\n${dayOutput}\n\`\`\``; // Format as code block

                     // Edit the original reply message (`initialMsg`)
                     if (scheduleContent.length > DISCORD_MESSAGE_LIMIT) {
                         // If too long, split the message
                         console.warn(`${cmdButtonTimestamp}: Today's schedule too long (${scheduleContent.length}). Splitting message.`);
                         // Edit the original message to just be a title
                         await initialMsg.edit({ content: `📅 **Today's Schedule (${dayName}):**`, components: [] }).catch(()=>{});
                         // Send the actual schedule content using the split helper
                         await sendSplitMessage(message.channel, dayOutput, `\`\`\`\n`, '\n\`\`\`');
                     } else {
                         // If short enough, edit the original message with the content
                         await initialMsg.edit({ content: scheduleContent, components: [] });
                     }
                     collector.stop('selection_made'); // Stop collector after showing schedule
                 }
                 // --- Weekly Schedule ---
                 else if (i.customId === 'cmd_schedule_week') {
                     // Sends schedule day-by-day as ephemeral follow-up messages
                     console.log(`${cmdButtonTimestamp}: Generating chunked weekly schedule (ephemeral)...`);
                     // Edit the deferral message (which is ephemeral)
                     await i.editReply({ content: "Fetching weekly schedule (Mon-Sun)...", components: [] });
                     let entriesFoundTotal = 0;
                     const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Monday to Sunday order
                     for (const dayIndex of dayOrder) {
                         const daySchedule = schedule[dayIndex];
                         const dayName = DAY_NAMES[dayIndex];
                         let dayOutput = '';
                         let entriesFoundThisDay = 0;
                         if (daySchedule && Object.keys(daySchedule).length > 0) {
                             const times = Object.keys(daySchedule).sort();
                             for (const time of times) {
                                 const showData = daySchedule[time];
                                 if (showData && showData.now) { // Only standard entries
                                     const formattedTime = formatTime12hr(time);
                                     const title = showData.now.replace(/\*+/g, '').trim();
                                     dayOutput += `${formattedTime} - ${title}\n`;
                                     entriesFoundThisDay++;
                                 }
                             }
                         }
                         // If entries were found for this day, send as a separate ephemeral follow-up
                         if (entriesFoundThisDay > 0) {
                             const scheduleChunk = `\`\`\`\n**${dayName}**\n${dayOutput}\n\`\`\``;
                             entriesFoundTotal++;
                             console.log(`${cmdButtonTimestamp}: Prepared ephemeral chunk for ${dayName}. Length: ${scheduleChunk.length}`);
                             try {
                                 // Send chunk ephemerally, truncate if necessary
                                 if (scheduleChunk.length > EPHEMERAL_CONTENT_LIMIT) {
                                     console.warn(`${cmdButtonTimestamp}: Weekly ephemeral chunk for ${dayName} too long (${scheduleChunk.length}). Truncating.`);
                                     await i.followUp({ content: scheduleChunk.substring(0, EPHEMERAL_CONTENT_LIMIT - 20) + "\n... (Truncated)\n\`\`\`", ephemeral: true });
                                 } else {
                                     await i.followUp({ content: scheduleChunk, ephemeral: true });
                                 }
                             } catch (followUpError) {
                                 console.error(`${cmdButtonTimestamp}: Error sending ephemeral schedule follow-up chunk for ${dayName}:`, followUpError);
                                 // Try to notify user about the error for that specific day
                                 await i.followUp({ content: `❌ Error sending schedule for ${dayName}.`, ephemeral: true}).catch(()=>{});
                             }
                         } else {
                             // console.log(`${cmdButtonTimestamp}: No standard entries found for ${dayName}. Skipping ephemeral chunk.`); // Can be verbose
                         }
                     } // End loop through days
                     // Final feedback after sending chunks
                     if (entriesFoundTotal === 0) {
                         console.log(`${cmdButtonTimestamp}: No standard schedule entries found for the entire week.`);
                         await i.editReply({ content: "No standard schedule entries found for the entire week.", components: [] }).catch(()=>{}); // Edit the "Fetching..." message
                     } else {
                         console.log(`${cmdButtonTimestamp}: Finished sending weekly schedule chunks ephemerally.`);
                         // Edit the "Fetching..." message to confirm completion
                         await i.editReply({ content: "✅ Weekly schedule sent as separate messages.", components: [] }).catch(()=>{});
                     }
                     collector.stop('selection_made'); // Stop collector after showing schedule
                 }
                 // --- Movie Listings ---
                 else if (i.customId === 'cmd_schedule_movies') {
                     titlePrefix = '--- Movie Listings This Week (Mon-Sun) ---';
                     let movieOutput = '';
                     let moviesFound = 0;
                     const moviePrefix = "MOVIE:"; // Assumes movies start with "MOVIE:" in schedule.js
                     const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Monday to Sunday
                     for (const dayIndex of dayOrder) {
                         const daySchedule = schedule[dayIndex];
                         if (!daySchedule) continue;
                         const times = Object.keys(daySchedule).sort();
                         for (const time of times) {
                             const showData = daySchedule[time];
                             // Check if 'now' field exists and starts with the movie prefix (case-insensitive)
                             if (showData && showData.now && showData.now.trim().toUpperCase().startsWith(moviePrefix)) {
                                 const dayName = DAY_NAMES[dayIndex];
                                 const formattedTime = formatTime12hr(time);
                                 const movieTitle = showData.now.trim().substring(moviePrefix.length).trim(); // Extract title
                                 movieOutput += `${dayName}, ${formattedTime} - ${movieTitle}\n`;
                                 moviesFound++;
                             }
                         }
                     }
                     let scheduleOutput = moviesFound === 0
                         ? "No entries marked with 'MOVIE:' found in the schedule for this week."
                         : movieOutput;
                     scheduleContent = `\`\`\`\n${titlePrefix}\n\n${scheduleOutput}\n\`\`\``; // Format as code block

                     // Edit the original reply message (`initialMsg`)
                     if (scheduleContent.length > DISCORD_MESSAGE_LIMIT) {
                         console.warn(`${cmdButtonTimestamp}: Movies schedule too long (${scheduleContent.length}). Splitting message.`);
                         await initialMsg.edit({ content: `🎬 **This Week's Movie Listings:**`, components: [] }).catch(()=>{}); // Edit title
                         await sendSplitMessage(message.channel, movieOutput, `\`\`\`\n`, '\n\`\`\`'); // Send split content
                     } else {
                         await initialMsg.edit({ content: scheduleContent, components: [] }); // Edit with full content
                     }
                     collector.stop('selection_made'); // Stop collector after showing schedule
                 }
             } catch(schedError) { // Catch errors during schedule processing
                 console.error(`${cmdButtonTimestamp}: Error processing schedule command choice '${i.customId}':`, schedError);
                 const errorReplyOptions = { content: "Sorry, an error occurred while fetching that schedule.", components: [] };
                 // Send error feedback appropriately (followUp if deferred for week, edit initialMsg otherwise)
                 if (i.customId === 'cmd_schedule_week' && (i.replied || i.deferred)) {
                     await i.followUp({ ...errorReplyOptions, ephemeral: true }).catch(() => {});
                 } else {
                     // Edit the original message sent by the bot (`initialMsg`)
                     await initialMsg.edit(errorReplyOptions).catch(() => {});
                 }
                 collector.stop('error'); // Stop collector on error
             }
         }); // End collector.on('collect') for !schedule

         collector.on('end', async (collected, reason) => {
             console.log(`${timestamp}: Schedule command collector for ${message.author.tag} ended. Reason: ${reason}`);
             // Fetch the initial message again to clean it up
             const finalScheduleMessage = await message.channel.messages.fetch(initialMsg.id).catch(() => null);
             if (!finalScheduleMessage) {
                 console.log(`${timestamp}: Schedule command message ${initialMsg.id} already deleted.`);
                 return;
             }
             // If timed out, delete the message with buttons
             if (reason === 'time') {
                 console.log(`${timestamp}: Deleting timed out schedule command message ${initialMsg.id}`);
                 await finalScheduleMessage.delete().catch(e => console.warn(`${timestamp} Could not delete schedule message on timeout: ${e.message}`));
             }
             // Otherwise (ended by selection/error), disable buttons if they haven't been removed by an edit
             else {
                 if (finalScheduleMessage.components && finalScheduleMessage.components.length > 0 && finalScheduleMessage.editable) {
                     console.log(`${timestamp}: Disabling buttons on ended schedule command message ${initialMsg.id}`);
                     const disabledRows = finalScheduleMessage.components.map(row => {
                         const newRow = ActionRowBuilder.from(row);
                         newRow.components.forEach(component => component.setDisabled(true));
                         return newRow;
                     });
                     // Keep the final content (which might be the schedule itself or an error)
                     await finalScheduleMessage.edit({ components: disabledRows }).catch(e => console.warn(`${timestamp} Could not disable components on ended schedule command message: ${e.message}`));
                 } else {
                     // Buttons were likely removed by editing the message content earlier
                     console.log(`${timestamp}: Schedule command message ${initialMsg.id} already edited or not editable. No buttons to disable.`);
                 }
             }
         }); // End collector.on('end') for !schedule
    } // End !schedule command

    // --- Command: !clear (Admin) ---
    // Deletes the bot's own messages from the channel within the last 12 hours.
    else if (command === 'clear') {
        console.log(`${timestamp}: Received !clear from ${message.author.tag} in #${message.channel.name}`);
        // Check admin permissions
        if (!userIsAdmin) {
            await message.reply("⛔ You don't have permission to use this command.").catch(e => console.error("Error replying to !clear:", e));
            return;
        }
        // Check bot permissions
        const botPermissions = message.guild?.members.me?.permissionsIn(message.channel);
        if (!botPermissions?.has(PermissionsBitField.Flags.ManageMessages)) {
            await message.reply("❌ I don't have the 'Manage Messages' permission in this channel, which is required to delete messages.").catch(e => console.error("Error replying to !clear:", e));
            return;
        }
        if (!botPermissions?.has(PermissionsBitField.Flags.ReadMessageHistory)) {
             // Technically fetch might still work partially, but it's needed for reliable operation
            await message.reply("❌ I don't have the 'Read Message History' permission needed to find my messages reliably.").catch(e => console.error("Error replying to !clear:", e));
            return;
        }

        let replyMsg = null;
        try {
            replyMsg = await message.reply(`🧹 Fetching my messages from the last 12 hours in this channel...`);
        } catch (e) { console.error(`${timestamp} Error sending initial clear message reply:`, e); return; }

        const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
        try {
            // Fetch recent messages
            const fetchedMessages = await message.channel.messages.fetch({ limit: 100 });
            // Filter messages: by bot, within 12 hours, and less than 14 days old (bulk delete limit)
            const messagesToDelete = fetchedMessages.filter(msg =>
                msg.author.id === client.user.id &&
                msg.createdTimestamp > twelveHoursAgo &&
                (Date.now() - msg.createdTimestamp) < FOURTEEN_DAYS_MS
            );
            const count = messagesToDelete.size;
            console.log(`${timestamp}: Found ${count} message(s) by me in the last 12 hours eligible for deletion.`);

            if (count === 0) {
                await replyMsg.edit("🧹 No recent messages from me found to delete.").catch(e => console.warn("Could not edit clear message reply:", e.message));
            } else if (count === 1) {
                await messagesToDelete.first().delete().catch(e => console.warn("Could not delete single message:", e.message));
                await replyMsg.edit(`✅ Successfully deleted 1 message.`).catch(e => console.warn("Could not edit clear message reply:", e.message));
            } else { // Use bulk delete for 2+ messages
                 // true = filter out messages older than 14 days automatically by API
                const deletedMessages = await message.channel.bulkDelete(messagesToDelete, true);
                console.log(`${timestamp}: Bulk deleted ${deletedMessages.size} messages.`);
                await replyMsg.edit(`✅ Successfully deleted ${deletedMessages.size} message(s).`).catch(e => console.warn("Could not edit clear message reply:", e.message));
            }
        } catch (error) {
            console.error(`${timestamp}: Error during !clear operation:`, error);
            let errorText = "❌ An error occurred while trying to delete messages.";
            if (error.code === 50034) { errorText += " (Cannot bulk delete messages older than 14 days)."; }
            else if (error.code === 50013) { errorText += " (Missing Permissions?)."; }
            // Edit the initial reply message with error info
            if (replyMsg?.editable) {
                await replyMsg.edit(`🧹 Clear operation finished with errors. ${errorText}`).catch(e => console.warn("Could not edit clear message reply on error:", e.message));
            } else { // Fallback if reply message isn't editable
                await message.channel.send(`🧹 Clear operation finished with errors. ${errorText}`).catch(e => console.warn("Could not send clear error message:", e.message));
            }
        }
    } // End !clear command

    // --- Command: !custom ---
    // Starts a poll to switch to Custom Channel mode.
    else if (command === 'custom') {
        console.log(`${timestamp}: Received !custom from ${message.author.tag} in #${message.channel.name}`);
        if (isCustomModeActive) {
            await message.reply("ℹ️ Custom Channel mode is already active.").catch(e => console.error("Error replying to !custom:", e));
            return;
        }
        // Check required config/scripts
        if (!customAhkPathTo || !customAhkPathBack || !fs.existsSync(customAhkPathTo) || !fs.existsSync(customAhkPathBack)) {
            await message.reply("⚠️ Cannot start Custom mode: Required AHK scripts (`CUSTOM_AHK_SCRIPT_PATH_TO` or `_BACK`) are not configured correctly or files not found.").catch(e => console.error("Error replying to !custom:", e));
            return;
        }
        if (!targetVoiceChannel) {
            await message.reply("⚠️ Cannot start Custom mode: Target voice channel (`TARGET_VOICE_CHANNEL_ID`) is not configured or found.").catch(e => console.error("Error replying to !custom:", e));
            return;
        }

        // Start the poll (logic similar to remote_custom)
        let initialReply = await message.reply("⏳ Starting public poll to switch to Custom Channel...").catch(e => {console.error("Error replying to !custom:", e); return null;});
        if (!initialReply) return; // Stop if initial reply failed

        const pollRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('custom_poll_yes').setLabel('Yes, Switch!').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('custom_poll_no').setLabel('No, Stay on Schedule').setStyle(ButtonStyle.Danger)
        );
        let yesVotes = 0; let noVotes = 0; const votedUsers = new Set();
        const pollDurationSeconds = Math.round(CUSTOM_POLL_TIMEOUT_MS / 1000);
        const pollEndTime = Date.now() + CUSTOM_POLL_TIMEOUT_MS;
        let pollUpdateIntervalId = null;

        const generatePollContent = (y, n) => { /* ... (Identical to remote_custom) ... */ const timeLeftMs = pollEndTime - Date.now(); const timeLeftString = timeLeftMs > 0 ? ` (${Math.ceil(timeLeftMs / 1000)}s left)` : ' (ended)'; return `**Poll: Switch to Custom Channel?**\n*(Vote ends in ${pollDurationSeconds} seconds${timeLeftString})*\n\nCurrent Votes: Yes - ${y} | No - ${n}`; };

        let pollMessage = null;
        try {
            pollMessage = await message.channel.send({ content: generatePollContent(0, 0), components: [pollRow] });
        } catch (e) { console.error(`${timestamp} Error sending initial custom poll message:`, e); return; }

        const customPollCollector = pollMessage.createMessageComponentCollector({ componentType: ComponentType.Button, time: CUSTOM_POLL_TIMEOUT_MS });
        pollUpdateIntervalId = setInterval(async () => { /* ... (Identical to remote_custom timer update) ... */ if (!pollMessage?.editable) { clearInterval(pollUpdateIntervalId); pollUpdateIntervalId = null; return; } try { await pollMessage.edit({ content: generatePollContent(yesVotes, noVotes), components: [pollRow] }); } catch(e) { if(e.code !== 10008) console.warn(`Error updating custom poll timer message ${pollMessage.id}:`, e.message); else { clearInterval(pollUpdateIntervalId); pollUpdateIntervalId = null;} } }, 10000);
        customPollCollector.on('collect', async i => { /* ... (Identical to remote_custom vote collection) ... */ await i.deferUpdate(); if (votedUsers.has(i.user.id)) return; votedUsers.add(i.user.id); if (i.customId === 'custom_poll_yes') yesVotes++; else noVotes++; try { if (pollMessage?.editable) await pollMessage.edit({ content: generatePollContent(yesVotes, noVotes), components: [pollRow] }); } catch(e) { if(e.code !== 10008) console.warn(`Error updating custom poll message after vote ${pollMessage.id}:`, e.message); } });
        customPollCollector.on('end', async (collected, reason) => { /* ... (Identical to remote_custom poll end logic) ... */
             if (pollUpdateIntervalId) { clearInterval(pollUpdateIntervalId); pollUpdateIntervalId = null; }
             console.log(`${timestamp}: !custom poll ended. Reason: ${reason}. Final Votes: Yes-${yesVotes}, No-${noVotes}`);
             let finalMessageContent = '';
             const finalPollMessage = await message.channel.messages.fetch(pollMessage.id).catch(() => null);
             let pollPassed = yesVotes > noVotes;
             if (pollPassed) {
                 finalMessageContent = `✅ Poll passed! Switching to Custom Channel mode... (Final Votes: Yes-${yesVotes}, No-${noVotes})`;
                 try { if (finalPollMessage?.editable) await finalPollMessage.edit({ content: finalMessageContent, components: [] }); }
                 catch (e) { console.warn(`Could not edit final custom poll message ${pollMessage.id} on success:`, e.message); }
                 try {
                     const statusMsg = await message.channel.send(`⚙️ Executing AHK script to switch...`);
                     await runAhkScript(customAhkPathTo, 'Switch To Custom Script');
                     isCustomModeActive = true; console.log(`${timestamp}: Custom mode ENABLED via !custom poll.`); consecutiveSkipVotes = 0;
                     if (targetVoiceChannel) { await updateEventNameInternal("Custom Channel"); }
                     startCustomModeTimer(message.channel);
                     const successText = `▶️ Custom mode started successfully!`;
                     const finalStatusMsg = await message.channel.messages.fetch(statusMsg.id).catch(()=>null);
                     if(finalStatusMsg?.editable) await finalStatusMsg.edit(successText); else await message.channel.send(successText);
                 } catch (scriptError) {
                     pollPassed = false; console.error(`${timestamp}: Failed to execute custom mode AHK script.`);
                     const errorText = `❌ Failed to execute the AHK script to switch to custom mode. Custom mode remains OFF. Check console logs.`;
                     await message.channel.send(errorText).catch(()=>{});
                     try { if (finalPollMessage?.editable) await finalPollMessage.edit({ content: `❌ Poll passed, but AHK script failed! Custom mode remains OFF. (Votes: Yes-${yesVotes}, No-${noVotes})`, components: [] }); }
                     catch (e) { console.warn(`Could not edit final custom poll message after script error ${pollMessage.id}:`, e.message); }
                 }
             } else {
                 finalMessageContent = `❌ Poll failed or tied! Custom mode switch cancelled. (Final Votes: Yes-${yesVotes}, No-${noVotes})`;
                 try { if (finalPollMessage?.editable) await finalPollMessage.edit({ content: finalMessageContent, components: [] }); }
                 catch (e) { console.warn(`Could not edit final custom poll message ${pollMessage.id} on failure:`, e.message); }
             }
             if (finalPollMessage && finalPollMessage.components.length > 0 && finalPollMessage.editable) {
                 const disabledRows = finalPollMessage.components.map(row => ActionRowBuilder.from(row).setComponents(row.components.map(c => ButtonBuilder.from(c).setDisabled(true))));
                 await finalPollMessage.edit({ components: disabledRows }).catch(e => console.warn(`${timestamp} Could not disable components on ended !custom poll message: ${e.message}`));
             }
         }); // End !custom poll 'end'
    } // End !custom command

    // --- Command: !ptv ---
    // Ends Custom Channel mode via user command.
    else if (command === 'ptv') {
        console.log(`${timestamp}: Received !ptv from ${message.author.tag} in #${message.channel.name}`);
        if (!isCustomModeActive) {
            await message.reply("ℹ️ Custom Channel mode is not currently active.").catch(e => console.error("Error replying to !ptv:", e));
            return;
        }
        if (!customAhkPathBack || !fs.existsSync(customAhkPathBack)) {
            await message.reply("⚠️ The AHK script to switch back (`CUSTOM_AHK_SCRIPT_PATH_BACK`) is not configured or found. Cannot end Custom mode automatically.").catch(e => console.error("Error replying to !ptv:", e));
            return; // Don't proceed if script is missing
        }
        // Feedback handled by endCustomMode
        await message.reply("⏳ Okay, attempting to end Custom Channel mode and return to schedule...").catch(e => console.error("Error replying to !ptv:", e));
        await endCustomMode(message, `Command !ptv used by ${message.author.tag}`); // Pass message object for context
    } // End !ptv command

     // --- Command: !youtube ---
     // Adds a YouTube video or playlist to the download queue.
    else if (command === 'youtube') {
        console.log(`${timestamp}: Received !youtube from ${message.author.tag} in #${message.channel.name}`);
        // Check prerequisites
        if (!videoDownloadFolder) { await message.reply("⚠️ Video download folder (`VIDEO_DOWNLOAD_FOLDER`) is not configured by the bot admin.").catch(e => console.error("Error replying:", e)); return; }
        if (!ffmpegPath || !fs.existsSync(ffmpegPath)) { await message.reply("⚠️ Re-encoding downloaded videos requires `ffmpeg`, but FFMPEG_PATH is not configured or found.").catch(e => console.error("Error replying:", e)); return; }

        const initialUrl = args[0]; // First argument is the URL
        // Join the rest of the arguments to form the potential subfolder name
        const potentialSubfolder = args.slice(1).join(' ').trim() || null;

        // Validate URL presence and basic structure
        if (!initialUrl) { await message.reply("Usage: `!youtube <URL> [Optional Subfolder Name]`").catch(e => console.error("Error replying:", e)); return; }
        try { new URL(initialUrl); } catch (_) { await message.reply("That doesn't look like a valid URL.").catch(e => console.error("Error replying:", e)); return; }

        // Send initial feedback message (public)
        let preliminaryStatusMsg = null;
        try {
            let statusText = `🧐 Checking YouTube URL type (this may take a moment)...`;
            if (potentialSubfolder) {
                statusText += `\n   📁 Target subfolder: \`${sanitizeSubfolderName(potentialSubfolder) || '(Invalid - Will use root)'}\``; // Show sanitized preview
            }
            preliminaryStatusMsg = await message.reply(statusText).catch(e => {console.error("Error sending prelim YT check msg:", e); return null;});
        } catch(e) { console.error("Error sending initial !youtube status message:", e); }

        // Process the URL (logic similar to remote_youtube modal submission)
        try {
            console.log(`${timestamp}: Performing preliminary check on URL with yt-dlp --print url: ${initialUrl}`);
            const prelimOptions = { /* ... (Identical to remote_youtube prelimOptions) ... */ print: 'url', flatPlaylist: true, playlistItems: `1-${PLAYLIST_VIDEO_LIMIT + 5}`, socketTimeout: 15 };
            const prelimOutputRaw = await ytDlpExec(initialUrl, prelimOptions);
            let extractedUrls = [];
            const prelimOutput = prelimOutputRaw.stdout || prelimOutputRaw; /* ... (Identical URL extraction) ... */ if (prelimOutput && typeof prelimOutput === 'string' && prelimOutput.trim().length > 0) { extractedUrls = prelimOutput.split('\n').map(line => line.trim()).filter(line => line && line.startsWith('http') && line !== initialUrl); console.log(`${timestamp}: Extracted ${extractedUrls.length} distinct video URLs using --print url.`); } else { console.warn(`${timestamp}: Preliminary check (--print url) did not return expected string output or was empty. Output:`, prelimOutput); }

            const isExplicitPlaylist = initialUrl.includes('list=');

            // --- Handle Playlist ---
            if (isExplicitPlaylist && extractedUrls.length > 0) { /* ... (Identical to remote_youtube playlist handling) ... */
                console.log(`${timestamp}: Explicit playlist detected with ${extractedUrls.length} videos found.`);
                const urlsToQueue = extractedUrls.slice(0, PLAYLIST_VIDEO_LIMIT); const addedCount = urlsToQueue.length; const originalCount = extractedUrls.length;
                let replyText = `▶️ Detected playlist! Adding ${addedCount} video(s) to the download queue`;
                if (originalCount > PLAYLIST_VIDEO_LIMIT) { replyText += ` (limited from ${originalCount} found).`; } else { replyText += `.`; }
                if (potentialSubfolder) { replyText += `\n   📁 Target subfolder: \`${sanitizeSubfolderName(potentialSubfolder) || '(Invalid - Will use root)'}\``; }
                const startingPosition = (isYoutubeDownloadActive ? 1 : 0) + youtubeQueue.length + 1;
                replyText += ` Your downloads start around position: ${startingPosition}.`;
                // Edit the initial status message
                if(preliminaryStatusMsg?.editable) await preliminaryStatusMsg.edit(replyText).catch(e=>console.warn("Couldn't edit prelim msg for playlist:", e.message));
                else await message.channel.send(replyText).catch(e=>console.error("Failed to send playlist confirmation", e)); // Fallback send
                // Add items to queue
                for (const videoUrl of urlsToQueue) { /** @type {YoutubeQueueItem} */ const queueItem = { url: videoUrl, sourceChannel: message.channel, user: message.author, subfolder: potentialSubfolder }; youtubeQueue.push(queueItem); }
                console.log(`${timestamp}: Added ${addedCount} videos from playlist via !youtube. Subfolder: ${potentialSubfolder}. New queue length: ${youtubeQueue.length}`);
            }
            // --- Handle Single Video ---
            else { /* ... (Identical to remote_youtube single video handling) ... */
                console.log(`${timestamp}: Treating as single video via !youtube.`);
                let editText = `➡️ Queuing single video...`;
                if (potentialSubfolder) { editText += `\n   📁 Target subfolder: \`${sanitizeSubfolderName(potentialSubfolder) || '(Invalid - Will use root)'}\``; }
                // Edit initial status message
                if(preliminaryStatusMsg?.editable) await preliminaryStatusMsg.edit(editText).catch(e=>console.warn("Couldn't edit prelim msg for single:", e.message));
                else await message.channel.send(editText).catch(e=>console.error("Failed to send single confirmation", e)); // Fallback send
                // Add item to queue
                /** @type {YoutubeQueueItem} */ const queueItem = { url: initialUrl, sourceChannel: message.channel, user: message.author, subfolder: potentialSubfolder }; youtubeQueue.push(queueItem);
                console.log(`${timestamp}: Added single video ${initialUrl} to queue via !youtube. Subfolder: ${potentialSubfolder}. New queue length: ${youtubeQueue.length}`);
            }
            setTimeout(processYoutubeQueue, 250); // Trigger queue processing

        } catch (prelimError) { /* ... (Identical to remote_youtube prelim error handling) ... */
            console.error(`${timestamp}: Error during preliminary !youtube URL check:`, prelimError);
            let errorText = `⚠️ Preliminary URL check failed (could not determine type). Attempting to queue as single video anyway...`;
            let queueAsSingle = true;
            if (prelimError?.stderr?.includes('is not a valid URL') || prelimError?.stderr?.includes('Unsupported URL')) { errorText = `❌ The provided URL is not valid or supported by yt-dlp: <${initialUrl}>`; queueAsSingle = false; }
            else if (prelimError?.stderr?.includes('Video unavailable')) { errorText = `⚠️ Video seems unavailable (private/deleted?), but adding to queue anyway...`; }
            if (potentialSubfolder) { errorText += `\n   📁 Target subfolder: \`${sanitizeSubfolderName(potentialSubfolder) || '(Invalid - Will use root)'}\``; }
            // Edit initial status message with error
            if(preliminaryStatusMsg?.editable) await preliminaryStatusMsg.edit(errorText).catch(e=>console.warn("Couldn't edit prelim msg on YT error:", e.message));
            else await message.channel.send(errorText).catch(e=>console.error("Couldn't send YT error status msg:", e)); // Fallback send
            // Queue if appropriate
            if (queueAsSingle) { /** @type {YoutubeQueueItem} */ const queueItem = { url: initialUrl, sourceChannel: message.channel, user: message.author, subfolder: potentialSubfolder }; youtubeQueue.push(queueItem); setTimeout(processYoutubeQueue, 250); }
        }
    } // End !youtube command

    // --- Command: !skip ---
    // Starts a poll to skip the current item in Custom Channel mode.
    else if (command === 'skip') {
        console.log(`${timestamp}: Received !skip from ${message.author.tag} in #${message.channel.name}`);
        if (!isCustomModeActive) { await message.reply("ℹ️ This command only works when Custom Channel mode is active.").catch(e => console.error("Error replying:", e)); return; }
        const now = Date.now();
        // Check cooldown
        if (now < skipVoteCooldownEndTimestamp) { const timeLeft = Math.ceil((skipVoteCooldownEndTimestamp - now) / 1000); await message.reply(`⏳ Please wait ${timeLeft} more second(s) before starting another skip vote.`).catch(e => console.error("Error replying:", e)); return; }
        // Check script config
        if (!skipCustomAhkPath || !fs.existsSync(skipCustomAhkPath)) { await message.reply("⚠️ The skip AHK script (`SKIP_CUSTOM_AHK_SCRIPT_PATH`) is not configured or file not found. Cannot start skip vote.").catch(e => console.error("Error replying:", e)); return; }
        if (!targetVoiceChannel) { await message.reply("⚠️ Target voice channel (`TARGET_VOICE_CHANNEL_ID`) not configured, cannot check member count for skip bypass.").catch(e => console.error("Error replying:", e)); return; }

        // --- Skip Bypass Check (2 users in VC) ---
        try { /* ... (Identical to remote_skipvote bypass check) ... */
            const currentVoiceChannel = await client.channels.fetch(targetVoiceChannelId);
            if (currentVoiceChannel?.type === ChannelType.GuildVoice) {
                const humanMembers = currentVoiceChannel.members.filter(m => !m.user.bot);
                console.log(`${timestamp}: Checking VC (${currentVoiceChannel.name}) human members for skip bypass. Count: ${humanMembers.size}`);
                if (humanMembers.size === 2) {
                    console.log(`${timestamp}: VC has exactly 2 human members. Bypassing poll and running skip script via !skip.`);
                    const bypassMsg = await message.reply(`⚙️ Only 2 users in voice chat. Bypassing poll and executing skip AHK script...`).catch(e=>{console.error("Error sending bypass msg:",e); return null;});
                    try {
                        await runAhkScript(skipCustomAhkPath, 'Skip Custom Item Script (Bypass)');
                        consecutiveSkipVotes++; await message.channel.send('✅ Skip AHK script executed (Bypass).').catch(()=>{}); // Public confirmation
                        skipVoteCooldownEndTimestamp = Date.now() + SKIP_VOTE_COOLDOWN_MS; setTimeout(checkAndUpdateVlcEventTitle, 1500);
                    } catch (scriptError) {
                        console.error(`${timestamp}: Failed to execute skip AHK script during !skip bypass.`);
                        const errorText = `❌ Failed to execute the skip AHK script during bypass. Check logs.`;
                        if(bypassMsg?.editable) await bypassMsg.edit(errorText).catch(()=>{}); else await message.channel.send(errorText).catch(()=>{});
                        skipVoteCooldownEndTimestamp = Date.now() + SKIP_VOTE_COOLDOWN_MS;
                    }
                    return; // Exit command after bypass attempt
                }
            } else { console.warn(`${timestamp}: Could not fetch target voice channel for !skip bypass or it's not a voice channel. Proceeding with poll.`); }
        } catch (fetchError) { console.error(`${timestamp}: Error fetching voice channel members for !skip bypass check:`, fetchError); await message.reply(`⚠️ Error checking voice channel members. Proceeding with poll...`).catch(()=>{}); }

        // --- Start Skip Poll ---
        console.log(`${timestamp}: Starting skip vote poll via !skip.`);
        skipVoteCooldownEndTimestamp = now + SKIP_VOTE_COOLDOWN_MS; // Start cooldown
        const currentSkipPollTimeoutMs = Math.max(MIN_SKIP_POLL_DURATION_MS, SKIP_POLL_TIMEOUT_MS - (consecutiveSkipVotes * SKIP_POLL_DECREMENT_MS));
        const skipPollDurationSeconds = Math.round(currentSkipPollTimeoutMs / 1000);
        const skipPollEndTime = now + currentSkipPollTimeoutMs;
        console.log(`${timestamp}: Starting skip poll. Consecutive skips: ${consecutiveSkipVotes}. Poll duration: ${skipPollDurationSeconds}s`);

        const skipPollRow = new ActionRowBuilder().addComponents( /* ... (Identical skip poll buttons) ... */ new ButtonBuilder().setCustomId('skip_poll_yes').setLabel('Yes, Skip It!').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('skip_poll_no').setLabel('No, Keep Watching').setStyle(ButtonStyle.Success) );
        let yesVotes = 0; let noVotes = 0; const votedUsers = new Set();
        let skipPollUpdateIntervalId = null;
        const generateSkipPollContent = (y, n) => { /* ... (Identical skip poll content generator) ... */ const timeLeftMs = skipPollEndTime - Date.now(); const timeLeftString = timeLeftMs > 0 ? ` (${Math.ceil(timeLeftMs / 1000)}s left)` : ' (ended)'; return `**Poll: Skip current Custom Channel item?**\n*(Vote ends in ${skipPollDurationSeconds} seconds${timeLeftString})*\n\nCurrent Votes: Yes (Skip) - ${y} | No (Keep) - ${n}`; };

        let skipPollMessage = null;
        try {
            skipPollMessage = await message.reply({ content: generateSkipPollContent(0, 0), components: [skipPollRow] }); // Reply to command with poll
        } catch (e) { console.error(`${timestamp} Error sending initial !skip poll message:`, e); skipVoteCooldownEndTimestamp = 0; /* Reset cooldown on error */ return; }

        const skipPollCollector = skipPollMessage.createMessageComponentCollector({ componentType: ComponentType.Button, time: currentSkipPollTimeoutMs });
        skipPollUpdateIntervalId = setInterval(async () => { /* ... (Identical skip poll timer update) ... */ if (!skipPollMessage?.editable) { clearInterval(skipPollUpdateIntervalId); skipPollUpdateIntervalId = null; return; } try { await skipPollMessage.edit({ content: generateSkipPollContent(yesVotes, noVotes), components: [skipPollRow] }); } catch(e) { if(e.code !== 10008) console.warn(`Error updating skip poll timer message ${skipPollMessage.id}:`, e.message); else { clearInterval(skipPollUpdateIntervalId); skipPollUpdateIntervalId = null;} } }, 10000);
        skipPollCollector.on('collect', async i => { /* ... (Identical skip poll vote collection) ... */ await i.deferUpdate(); if (votedUsers.has(i.user.id)) return; votedUsers.add(i.user.id); if (i.customId === 'skip_poll_yes') yesVotes++; else noVotes++; try { if (skipPollMessage?.editable) await skipPollMessage.edit({ content: generateSkipPollContent(yesVotes, noVotes), components: [skipPollRow] }); } catch(e) { if(e.code !== 10008) console.warn(`Error updating skip poll message after vote ${skipPollMessage.id}:`, e.message); } });
        skipPollCollector.on('end', async (collected, reason) => { /* ... (Identical skip poll end logic) ... */
             if (skipPollUpdateIntervalId) { clearInterval(skipPollUpdateIntervalId); skipPollUpdateIntervalId = null; }
             console.log(`${timestamp}: !skip poll ended. Reason: ${reason}. Final Votes: Yes-${yesVotes}, No-${noVotes}`);
             let finalSkipMessageContent = '';
             const finalSkipPollMessage = await message.channel.messages.fetch(skipPollMessage.id).catch(() => null);
             let pollPassed = yesVotes > noVotes;
             if (pollPassed) {
                 console.log(`${timestamp}: Skip poll PASSED via !skip. Executing skip AHK script.`);
                 consecutiveSkipVotes++; console.log(`${timestamp}: Consecutive skips incremented to ${consecutiveSkipVotes}.`);
                 finalSkipMessageContent = `✅ Skip vote passed! Executing skip AHK script... (Final Votes: Yes-${yesVotes}, No-${noVotes})`;
                 try { if (finalSkipPollMessage?.editable) await finalSkipPollMessage.edit({ content: finalSkipMessageContent, components: [] }); } catch (e) { console.warn(`Could not edit final skip poll message ${skipPollMessage.id} on pass:`, e.message); }
                 try {
                     const skipStatusMsg = await message.channel.send(`⚙️ Executing skip AHK script...`);
                     await runAhkScript(skipCustomAhkPath, 'Skip Custom Item Script');
                     const finalSkipStatusMsg = await message.channel.messages.fetch(skipStatusMsg.id).catch(()=>null);
                     if (finalSkipStatusMsg?.editable) await finalSkipStatusMsg.edit('✅ Skip AHK script executed successfully.'); else await message.channel.send('✅ Skip AHK script executed successfully.');
                     setTimeout(checkAndUpdateVlcEventTitle, 1500);
                 } catch (scriptError) {
                     pollPassed = false; console.error(`${timestamp}: Failed to execute skip AHK script after !skip poll passed.`);
                     consecutiveSkipVotes = 0; console.log(`${timestamp}: Consecutive skips reset due to script error.`);
                     await message.channel.send(`❌ Failed to execute the skip AHK script. Check logs.`);
                     try { if (finalSkipPollMessage?.editable) await finalSkipPollMessage.edit({ content: `❌ Skip vote passed, but AHK script failed! (Votes: Yes-${yesVotes}, No-${noVotes})`, components: [] }); } catch (e) { console.warn(`Could not edit final skip poll message after script error ${skipPollMessage.id}:`, e.message); }
                 }
             } else {
                 console.log(`${timestamp}: Skip poll FAILED or TIED via !skip. Skip cancelled.`);
                 consecutiveSkipVotes = 0; console.log(`${timestamp}: Consecutive skips reset due to failed/tied vote.`);
                 if (yesVotes === 0 && noVotes === 0 && reason === 'time') finalSkipMessageContent = `⌛ Skip vote ended! No votes received. Nothing skipped.`;
                 else finalSkipMessageContent = `❌ Skip vote failed or tied! Nothing skipped. (Final Votes: Yes-${yesVotes}, No-${noVotes})`;
                 try { if (finalSkipPollMessage?.editable) await finalSkipPollMessage.edit({ content: finalSkipMessageContent, components: [] }); } catch (e) { console.warn(`Could not edit final skip poll message ${skipPollMessage.id} on fail/tie:`, e.message); }
             }
             if (finalSkipPollMessage && finalSkipPollMessage.components.length > 0 && finalSkipPollMessage.editable) {
                 const disabledRows = finalSkipPollMessage.components.map(row => ActionRowBuilder.from(row).setComponents(row.components.map(c => ButtonBuilder.from(c).setDisabled(true))));
                 await finalSkipPollMessage.edit({ components: disabledRows }).catch(e => console.warn(`${timestamp} Could not disable components on ended !skip poll message: ${e.message}`));
             }
         }); // End !skip poll 'end'
    } // End !skip command

     // --- Command: !help ---
     // Provides help information via buttons.
    else if (command === 'help') {
        console.log(`${timestamp}: Received !help from ${message.author.tag} in #${message.channel.name}`);
        // Help buttons
        const helpRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('cmd_help_refresh_stream').setLabel('Stream is broken!').setStyle(ButtonStyle.Danger).setEmoji('🚨'),
            new ButtonBuilder().setCustomId('cmd_help_list_commands').setLabel('List Commands').setStyle(ButtonStyle.Secondary).setEmoji('❓'),
            new ButtonBuilder().setCustomId('cmd_help_file_location').setLabel('Custom Files Location').setStyle(ButtonStyle.Primary).setEmoji('📁')
        );
        let helpMessage = null;
        try {
            // Send initial prompt with buttons
            helpMessage = await message.reply({ content: `How can I help? (Buttons active for ${REMOTE_TIMEOUT_MS / 1000}s)`, components: [helpRow] });
        } catch(e) { console.error(`${timestamp} Error sending !help buttons:`, e); return; }

        // Collector for help buttons
        const collector = helpMessage.createMessageComponentCollector({ componentType: ComponentType.Button, time: REMOTE_TIMEOUT_MS });

        collector.on('collect', async i => {
            // Allow anyone to click help buttons? Or restrict to author? Let's restrict for now.
            if (i.user.id !== message.author.id) {
                await i.reply({ content: "This help interaction isn't for you! Use `!help` yourself.", ephemeral: true });
                return;
            }

            const buttonTimestamp = `[${new Date().toLocaleString()}] CMD HELP BTN ${i.customId}`;
            console.log(`${buttonTimestamp}: Help command button '${i.customId}' clicked by ${i.user.tag}`);

            try {
                // --- Refresh Stream Help ---
                if (i.customId === 'cmd_help_refresh_stream') {
                    await i.deferUpdate(); // Acknowledge click
                    // Edit the original help message
                    await helpMessage.edit({ content: "Okay, attempting to refresh the stream...", components: [] }).catch(e=>console.error("Error editing help message:", e));
                    collector.stop('refresh_triggered'); // Stop collector as action is taken
                    await executeRefreshSequence(i); // Pass interaction for feedback
                }
                // --- List Commands Help ---
                else if (i.customId === 'cmd_help_list_commands') {
                    await i.deferReply({ ephemeral: true }); // Reply ephemerally
                    let helpText = `**Basic Commands:**${commandList}\n**Custom Channel Only Commands:**${customModeCommandList}`;
                    await i.editReply({ content: helpText.substring(0, EPHEMERAL_CONTENT_LIMIT) });
                }
                // --- File Location Help ---
                else if (i.customId === 'cmd_help_file_location') {
                    await i.deferReply({ ephemeral: true }); // Reply ephemerally
                    let fileReply = '';
                    if (fileManagementUrl) {
                        fileReply = `Custom Channel files (for !browse and manual playback) are managed externally. You might find them [at this shared location](${fileManagementUrl}). Please use valid video formats.`;
                    } else {
                        fileReply = `The file management URL hasn't been configured in the bot's settings. Please ask an administrator for the location where Custom Channel files should be placed (e.g., a shared drive folder).`;
                    }
                    await i.editReply({ content: fileReply });
                }
            } catch (interactionError) { // Catch errors during button processing
                console.error(`${buttonTimestamp}: Error handling help button interaction:`, interactionError);
                try { // Try to send ephemeral error feedback
                    const errorContent = { content: 'Sorry, there was an error processing that help request.', ephemeral: true };
                    if (i.replied || i.deferred) { await i.followUp(errorContent).catch(() => {}); }
                    else { await i.reply(errorContent).catch(() => {}); }
                } catch (followUpError) { console.error(`${buttonTimestamp}: Also failed to send error follow-up for help button:`, followUpError); }
            }
        }); // End collector.on('collect') for !help

        collector.on('end', async (collected, reason) => {
            console.log(`${timestamp}: Help command button collector for ${message.author.tag} ended. Reason: ${reason}`);
            // Fetch final state of the help message
            const finalHelpMessage = await message.channel.messages.fetch(helpMessage.id).catch(() => null);
            if (!finalHelpMessage) { console.log(`${timestamp}: Help message ${helpMessage.id} already deleted.`); return; }

            // If timed out, delete the message
            if (reason === 'time') {
                console.log(`${timestamp}: Deleting timed out help message ${helpMessage.id}`);
                await finalHelpMessage.delete().catch(e => console.warn(`${timestamp} Could not delete help message on timeout: ${e.message}`));
            }
            // Otherwise (ended by action/error), disable buttons if present
            else {
                 if (finalHelpMessage.components && finalHelpMessage.components.length > 0 && finalHelpMessage.editable) {
                    console.log(`${timestamp}: Disabling buttons on ended help message ${helpMessage.id}`);
                    const disabledRows = finalHelpMessage.components.map(row => { /* ... (disable buttons) ... */ const newRow = ActionRowBuilder.from(row); newRow.components.forEach(component => component.setDisabled(true)); return newRow; });
                    // Keep content unless refresh was triggered
                    const finalContent = (reason === 'refresh_triggered' && finalHelpMessage.editable) ? finalHelpMessage.content : '**Help Menu (Ended)**';
                    await finalHelpMessage.edit({ content: finalContent, components: disabledRows }).catch(e => console.warn(`${timestamp} Could not disable components on ended help message: ${e.message}`));
                } else { console.log(`${timestamp}: Help message ${helpMessage.id} has no components, was deleted, or is not editable.`); }
            }
        }); // End collector.on('end') for !help
    } // End !help command

    // --- Command: !toggle (Admin) ---
    // Directly toggles custom mode state without running scripts.
    else if (command === 'toggle') {
        console.log(`${timestamp}: Received !toggle from ${message.author.tag} in #${message.channel.name}`);
        if (!userIsAdmin) { await message.reply("⛔ You don't have permission to use this command.").catch(e => console.error("Error replying:", e)); return; }
        // Check prerequisites needed for state changes (event updates, timer)
        if (!customAhkPathTo || !customAhkPathBack || !targetVoiceChannel) { await message.reply("⚠️ Cannot toggle mode cleanly: Required AHK scripts (for state assumptions) or target voice channel not configured.").catch(e => console.error("Error replying:", e)); return; }

        const newState = !isCustomModeActive;
        console.log(`[Toggle] Admin ${message.author.tag} forcing mode toggle. Current: ${isCustomModeActive}, New: ${newState}`);
        let replyMsg = "";
        isCustomModeActive = newState; // Flip the state

        if (isCustomModeActive) { // Toggled TO Custom
            console.log("[Toggle] Forced state TO Custom Mode (No AHK Script Run).");
            if (customModeTimerId) clearTimeout(customModeTimerId); // Clear old timer
            startCustomModeTimer(message.channel); // Starts timer & VLC check
            if (targetVoiceChannel) await updateEventNameInternal("Custom Channel"); // Update event
            consecutiveSkipVotes = 0; // Reset skips
            replyMsg = "⚙️ Toggled **TO** Custom Channel mode (AHK Scripts **NOT** run). Timer started, event updated.";
        } else { // Toggled FROM Custom
            console.log("[Toggle] Forced state FROM Custom Mode (No AHK Script Run).");
            if (customModeTimerId) clearTimeout(customModeTimerId); customModeTimerId = null; // Clear timer
            stopVlcTitleCheckInterval(); // Stop VLC check
            if (stillWatchingPromptMessage) { await stillWatchingPromptMessage.delete().catch(e => console.warn("[Toggle] Could not delete 'Still Watching' prompt:", e.message)); stillWatchingPromptMessage = null; } // Clear prompt
            // Update event back to schedule
            const currentShow = getCurrentShowTitle();
            if (currentShow && targetVoiceChannel) await updateEventNameInternal(currentShow);
            else if (targetVoiceChannel) await updateEventNameInternal("Stream Starting Soon");
            consecutiveSkipVotes = 0; // Reset skips
            replyMsg = `⚙️ Toggled **FROM** Custom Channel mode back to Schedule (AHK Scripts **NOT** run). Timer stopped, event updated.`;
        }
        await message.reply(replyMsg).catch(e => console.error("Error replying to !toggle:", e));
    } // End !toggle command

    // --- Command: !cancel ---
    // Cancels the user's own active or queued YouTube downloads.
    else if (command === 'cancel') {
        console.log(`${timestamp}: Received !cancel from ${message.author.tag} in #${message.channel.name}`);
        // Requires custom mode only because downloads are primarily for that mode?
        // Could potentially allow cancelling even if mode switched back. For now, require custom mode.
        if (!isCustomModeActive) { await message.reply("ℹ️ Downloads can currently only be cancelled while in Custom Channel mode.").catch(e => console.error("Error replying:", e)); return; }
        if (!videoDownloadFolder) { await message.reply("⚠️ Video downloads are not configured, cannot cancel anything.").catch(e => console.error("Error replying:", e)); return; }

        const userId = message.author.id;
        let cancelledQueueCount = 0;
        let activeCancelled = false;

        // Check active download
        if (isYoutubeDownloadActive && currentDownloadJob?.user?.id === userId && currentAbortController) {
            console.log(`${timestamp}: User ${message.author.tag} cancelling their active download: ${currentDownloadJob.url}`);
            currentAbortController.abort(); activeCancelled = true;
        }
        // Filter queue
        const initialQueueLength = youtubeQueue.length;
        const newQueue = youtubeQueue.filter(job => job.user.id !== userId);
        cancelledQueueCount = initialQueueLength - newQueue.length;
        youtubeQueue.length = 0; youtubeQueue.push(...newQueue); // Update queue

        console.log(`${timestamp}: User ${message.author.tag} used !cancel. Cancelled ${cancelledQueueCount} pending item(s). Active cancelled: ${activeCancelled}. New queue length: ${youtubeQueue.length}`);

        // Formulate and send feedback
        let replyMessage = ''; /* ... (Identical feedback logic as remote_cancel) ... */ if (activeCancelled && cancelledQueueCount > 0) { replyMessage = `🗑️ Cancelled your active download and removed ${cancelledQueueCount} pending item(s) from the queue.`; } else if (activeCancelled) { replyMessage = `🗑️ Cancelled your active download. No other items were pending for you in the queue.`; } else if (cancelledQueueCount > 0) { replyMessage = `🗑️ Removed ${cancelledQueueCount} pending item(s) from the queue. Your download was not the active one.`; } else { replyMessage = `ℹ️ No active or pending downloads found for you to cancel.`; }
        await message.reply(replyMessage).catch(e => console.error("Error replying to !cancel:", e));
    } // End !cancel command

    // --- Command: !cancelall (Admin) ---
    // Cancels ALL active and queued YouTube downloads.
    else if (command === 'cancelall') {
        console.log(`${timestamp}: Received !cancelall from ${message.author.tag} in #${message.channel.name}`);
        if (!userIsAdmin) { await message.reply("⛔ You don't have permission to use this command.").catch(e => console.error("Error replying:", e)); return; }
        if (!isCustomModeActive) { await message.reply("ℹ️ Downloads can currently only be cancelled while in Custom Channel mode.").catch(e => console.error("Error replying:", e)); return; }
        if (!videoDownloadFolder) { await message.reply("⚠️ Video downloads are not configured, cannot cancel anything.").catch(e => console.error("Error replying:", e)); return; }

        const initialQueueLength = youtubeQueue.length;
        let activeCancelled = false;
        // Cancel active download if present
        if (isYoutubeDownloadActive && currentAbortController) {
            console.log(`${timestamp}: Admin ${message.author.tag} cancelling ALL downloads via !cancelall, including active: ${currentDownloadJob?.url}`);
            currentAbortController.abort(); activeCancelled = true;
        } else { console.log(`${timestamp}: Admin ${message.author.tag} cancelling ALL pending downloads via !cancelall. No download was active.`); }
        // Clear the queue
        youtubeQueue.length = 0;
        console.log(`${timestamp}: Cleared ${initialQueueLength} pending items via !cancelall. Active cancelled: ${activeCancelled}. Queue is now empty.`);
        await message.reply(`💣 Cancelled ${activeCancelled ? 'the active download and ' : ''}${initialQueueLength} pending download(s) by admin order. The queue is now empty.`).catch(e => console.error("Error replying to !cancelall:", e));
    } // End !cancelall command

    // --- Command: !browse ---
    // Initiates the interactive file browser.
     else if (command === 'browse') {
         console.log(`${timestamp}: Received !browse from ${message.author.tag} in #${message.channel.name}`);
         // Pass the message object to handle replies and context
         await startBrowseSequence(message);
     } // End !browse command

    // --- Add other command handlers here as needed ---

}); // End of messageCreate event handler


// =============================================================================
// === General Error Handling & Login ===
// =============================================================================

// --- Discord Client Error Events ---
client.on('error', error => {
    console.error(`[${new Date().toLocaleString()}] Discord Client Error:`, error);
    // Optionally add specific handling for common recoverable errors like connection resets
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message.includes('connect ETIMEDOUT')) {
        console.warn('   -> Connection issue detected. discord.js will attempt to reconnect automatically.');
    }
    // Add handling for other specific error codes if needed
});

client.on('warn', warning => {
    console.warn(`[${new Date().toLocaleString()}] Discord Client Warning:`, warning);
});

// --- Graceful Shutdown Handler ---
// Attempts to clean up resources before exiting the process.
function cleanupAndExit(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    // 1. Stop Timers and Intervals
    console.log("Stopping timers and intervals...");
    stopVlcTitleCheckInterval();
    if (customModeTimerId) clearTimeout(customModeTimerId);
    if (etaUpdateIntervalId) clearInterval(etaUpdateIntervalId);

    // 2. Cancel Active Download (if any)
    if (currentAbortController && !currentAbortController.signal.aborted) {
        console.log("Aborting active YouTube download (if any)...");
        currentAbortController.abort();
        // Note: The download process might take a moment to fully stop and clean up files.
    }

    // 3. Clean up Active Browse Sessions
    console.log(`Cleaning up ${activeBrowseSessions.size} active browse session(s)...`);
    const cleanupPromises = Array.from(activeBrowseSessions.keys()).map(async messageId => {
        const session = activeBrowseSessions.get(messageId);
        if (session) {
            // Stop all collectors associated with the session
            session.buttonCollector?.stop('shutdown');
            session.numberInputCollector?.stop('shutdown');
            session.searchInputCollector?.stop('shutdown');
            session.browsePollCollector?.stop('shutdown'); // Also clears poll timer interval

            // Attempt to edit the browse message to indicate shutdown (best effort)
            try {
                // Try to resolve the channel from known session properties
                 let channel = null;
                 if (session.interaction?.channel) channel = session.interaction.channel;
                 else if (session.browsePollMessage?.channel) channel = session.browsePollMessage.channel;
                 // Fallback: Look up channel by ID from cache
                 else if (session.interaction?.channelId) channel = client.channels.cache.get(session.interaction.channelId);
                 else if (session.browsePollMessage?.channelId) channel = client.channels.cache.get(session.browsePollMessage.channelId);

                 if(channel && channel.isTextBased()) {
                    const msg = await channel.messages.fetch(messageId).catch(()=>{}); // Fetch message
                    // If message exists, is editable, and has components, disable them
                    if(msg?.editable && msg.components.length > 0) {
                        const disabledRows = msg.components.map(row => ActionRowBuilder.from(row).setComponents(row.components.map(c => ButtonBuilder.from(c).setDisabled(true))));
                        await msg.edit({content: '**Bot shutting down... Browse session ended.**', embeds: [], components: disabledRows}).catch(()=>{});
                        console.log(`   - Disabled components for ended browse session ${messageId}`);
                    } else if (msg?.editable) {
                        // Edit content even if no components?
                        await msg.edit({content: '**Bot shutting down... Browse session ended.**', embeds: []}).catch(()=>{});
                    }
                 } else {
                     console.warn(`   - Could not resolve channel reliably for browse session ${messageId} during shutdown.`);
                 }
            } catch (editError) {
                 console.warn(`   - Could not edit browse message ${messageId} on shutdown: ${editError.message}`);
            }
        }
        activeBrowseSessions.delete(messageId); // Remove from map regardless
    });

    // Wait for browse cleanup attempts to finish (or timeout)
    Promise.allSettled(cleanupPromises).then(() => {
        console.log("Browse session cleanup finished.");
        // 4. Destroy Discord Client
        console.log("Destroying Discord client...");
        client.destroy();
        console.log("Client destroyed. Exiting process.");
        process.exit(0); // Exit cleanly
    });

    // Force exit after a timeout if cleanup hangs
    setTimeout(() => {
        console.warn("Graceful shutdown timed out (5s). Forcing exit.");
        process.exit(1); // Exit with error code
    }, 5000);
}

// Listen for termination signals
process.on('SIGINT', () => cleanupAndExit('SIGINT')); // Ctrl+C
process.on('SIGTERM', () => cleanupAndExit('SIGTERM')); // kill command

// --- Login ---
console.log("Attempting to log in to Discord...");
client.login(token).catch(loginError => {
    console.error("!!!!!!!!!!!!!!!! LOGIN FAILED !!!!!!!!!!!!!!!!");
    console.error(`Error Code: ${loginError.code}`);
    console.error(loginError.message);
     // Provide hints for common login errors
     if (loginError.code === 'DisallowedIntents') {
        console.error("\nHint: Ensure all required Gateway Intents are enabled for the bot in the Discord Developer Portal:");
        console.error("- GUILDS");
        console.error("- GUILD_MESSAGES");
        console.error("- MESSAGE_CONTENT (Privileged)");
        console.error("- GUILD_SCHEDULED_EVENTS");
        console.error("- GUILD_VOICE_STATES");
    } else if (loginError.code === 'TokenInvalid') {
         console.error("\nHint: The DISCORD_BOT_TOKEN in your .env file is incorrect or missing.");
    }
    process.exit(1); // Exit if login fails
});
