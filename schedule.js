// schedule.js
const schedule = {
    // Day 0: Sunday
    0: {
        "09:00": { now: "Morning Cartoons", next: "Sunday News" },
        // ...
    },
    // Day 1: Monday
    1: {
        "10:00": { now: "Morning Show", next: "Cooking Time", image: "https://example.com/images/cooking.png" },
        // ...
    },
    // Day 3: Wednesday
    3: {
        "12:30": { now: "Scrubs", next: "South Park" },
        "13:00": { now: "South Park", next: "Invader Zim" },
        // Example Custom Message (will ONLY be posted, not used for !now or event name)
        "13:30": { customMessage: "**Reminder:** Server meeting at 2PM!" },
        "14:00": { now: "MOVIE: Spider-Man", next: "News Update" },
        // ...
    },
    // ... other days (2, 4, 5, 6) ...
};
module.exports = schedule;
