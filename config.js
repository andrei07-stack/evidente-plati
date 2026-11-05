// Configurare aplicație.
// Pune aici Client ID-ul OAuth creat în Google Cloud Console (vezi README.md).
// Cât timp e gol, aplicația rulează în MOD DEMO: datele stau doar în browser, fără calendar.
window.APP_CONFIG = {
  GOOGLE_CLIENT_ID: '724740677973-jmp9kngqptf24una7fp5qkhaea2qsp47.apps.googleusercontent.com',

  // Numele calendarului dedicat, creat automat la prima conectare.
  CALENDAR_NAME: 'Evidențe plăți',
  TIME_ZONE: 'Europe/Bucharest',

  // Ora evenimentului în ziua scadenței și notificările (zile înainte; Google acceptă max. 28 zile).
  EVENT_HOUR: 9,
  POPUP_REMINDER_DAYS: [14, 7, 1],
  EMAIL_REMINDER_DAYS: [7],
};
