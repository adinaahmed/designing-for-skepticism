/* AI Advice Study — Google Apps Script web app (one link for all participants).
   Setup: upload AI_Advice_Study.html to your Google Drive, paste this file into a new project at
   script.google.com, then Deploy -> New deployment -> Web app (Execute as: Me, Who has access: Anyone).
   Data: every finished session is saved as one CSV file in the Drive folder "AI_Advice_Study_data". */

const HTML_FILE_NAME = "AI_Advice_Study.html";
const DATA_FOLDER_NAME = "AI_Advice_Study_data";

function doGet(e) {
  const files = DriveApp.getFilesByName(HTML_FILE_NAME);
  if (!files.hasNext()) {
    return HtmlService.createHtmlOutput("<p>Setup problem: the file " + HTML_FILE_NAME + " was not found in the owner's Google Drive.</p>");
  }
  let html = files.next().getBlob().getDataAsString("UTF-8");
  const p = (e && e.parameter) || {};
  const params = { pilot: p.pilot === "1" ? "1" : "", offline: "" };
  html = html.replace("/*__GAS_PARAMS__*/", "window.GAS_PARAMS = " + JSON.stringify(params) + ";");
  return HtmlService.createHtmlOutput(html)
    .setTitle("AI Advice Study")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

// Next condition 0, 1, 2, ... (the page uses it modulo 20: group = c % 2, round order = floor(c / 2) % 5, picture half = floor(c / 10) % 2).
function nextCondition() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const c = Number(props.getProperty("next_condition") || 0);
    props.setProperty("next_condition", String(c + 1));
    return c;
  } finally {
    lock.releaseLock();
  }
}

function dataFolder_() {
  const it = DriveApp.getFoldersByName(DATA_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(DATA_FOLDER_NAME);
}

// Save one finished session as a CSV file.
function saveData(filename, csv) {
  if (typeof filename !== "string" || typeof csv !== "string") return "bad request";
  if (csv.length > 5 * 1024 * 1024) return "file too large";
  const safe = filename.replace(/[^A-Za-z0-9_.\-]/g, "_").slice(0, 120);
  if (!/\.csv$/.test(safe)) return "bad file name";
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    dataFolder_().createFile(safe, csv, MimeType.CSV);
  } finally {
    lock.releaseLock();
  }
  return "ok";
}

// Optional: run this once from the editor (select resetConditionCounter, click Run) to start the rotation at 0 again,
// e.g. after your own test runs.
function resetConditionCounter() {
  PropertiesService.getScriptProperties().setProperty("next_condition", "0");
}
