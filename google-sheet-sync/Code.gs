/**
 * @OnlyCurrentDoc
 * Limits this script's permission to the one spreadsheet it's attached to,
 * so Google never grants it access to your other sheets.
 */

/**
 * The Real Total — Google Sheet sync backend for purchases (the "Bought" tab),
 * the calculator and its saved scenarios.
 *
 * Setup:
 * 1. Create a new Google Sheet (any name). This script rewrites its own three
 *    tabs on every sync.
 * 2. Extensions -> Apps Script.
 * 3. Delete the default code in Code.gs and paste this whole file in.
 * 4. Set your secret WITHOUT putting it in this file: click Project Settings
 *    (the gear icon) -> Script Properties -> Add script property.
 *    Property = SECRET, Value = the key the app's "Generate a key" button made
 *    (or any 20+ character random string you make up).
 * 5. Deploy -> New deployment -> gear next to "Select type" -> "Web app".
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 6. Authorize it when asked. If Google says it hasn't verified the app, click
 *    Advanced -> Go to (your project) -> Allow; it's your own script.
 * 7. Copy the Web app URL it gives you (ends in /exec).
 * 8. In The Real Total, open Bought -> Google Sheet sync, paste the URL and the
 *    same secret key, and tap Connect.
 *
 * The "Hauls", "Items" and "Calculator" tabs are created automatically on the
 * first sync. Columns after the editable ones (totals, profit, status) are
 * filled in by the app for easy reading — edits to those columns are ignored
 * and overwritten. "Calculator" holds the calculator and its saved scenarios
 * as app data; don't edit it.
 *
 * Security notes:
 * - The secret lives only in Script Properties and in your own browser, never
 *   in this file, so this code is safe to keep in a public repo.
 * - "Who has access: Anyone" means anyone with BOTH the Web app URL and the
 *   secret can read and overwrite these three tabs. Don't share either one, and
 *   don't reuse a secret you use anywhere else.
 * - The secret is only accepted in a POST body (never in the URL), so it stays
 *   out of browser history and server logs.
 * - Everything written is checked against a fixed column list, capped in size,
 *   and text that starts with = + - @ is stored as plain text so it can never
 *   run as a spreadsheet formula.
 */

const SHEET_HAULS = "Hauls";
const SHEET_ITEMS = "Items";
const SHEET_CALC = "Calculator";

// Editable columns — the only ones read back into the app.
const HAUL_COLUMNS = ["id", "date", "store", "name", "notes"];
const ITEM_COLUMNS = [
  "id", "haulId", "name", "qty", "unitRetail", "totalPaid", "taxPaid", "resalePrice",
  "soldQty", "soldTotal", "fees", "soldDate", "platform", "location", "notes"
];
// Read-only columns the app computes for you.
const HAUL_COMPUTED = ["itemCount", "retail", "paid", "tax", "saved", "soldTotal", "profit"];
const ITEM_COMPUTED = ["unitCost", "status", "profit"];

const NUMERIC_COLUMNS = [
  "qty", "unitRetail", "totalPaid", "taxPaid", "resalePrice", "soldQty", "soldTotal", "fees",
  "itemCount", "retail", "paid", "tax", "saved", "profit", "unitCost"
];
const DATE_COLUMNS = ["date", "soldDate"];

const MAX_ROWS = 5000;
const MAX_TEXT = 200;
const MAX_BODY = 2000000;
const MAX_CALC = 1000000;
// A cell holds at most 50,000 characters.
const CALC_CHUNK = 40000;

function getSecret() {
  const secret = PropertiesService.getScriptProperties().getProperty("SECRET");
  if (!secret) {
    throw new Error("SECRET script property is not set - see the setup comment at the top of this file.");
  }
  return secret;
}

// Compares every character so a wrong guess takes the same time however
// much of it matched.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function doGet() {
  return jsonResponse({ error: "This sync only accepts POST requests from The Real Total." });
}

function doPost(e) {
  let secret;
  try {
    secret = getSecret();
  } catch (err) {
    return jsonResponse({ error: String(err.message) });
  }

  if (!e || !e.postData || typeof e.postData.contents !== "string") {
    return jsonResponse({ error: "empty request" });
  }
  if (e.postData.contents.length > MAX_BODY) {
    return jsonResponse({ error: "request too large" });
  }

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ error: "invalid JSON body" });
  }
  if (!body || typeof body.key !== "string" || !safeEqual(body.key, secret)) {
    return jsonResponse({ error: "unauthorized" });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (body.action === "pull") {
    return jsonResponse({
      hauls: readSheet(ss, SHEET_HAULS, HAUL_COLUMNS),
      items: readSheet(ss, SHEET_ITEMS, ITEM_COLUMNS),
      calc: readCalc(ss)
    });
  }

  if (body.action === "push") {
    if (!Array.isArray(body.hauls) || !Array.isArray(body.items)) {
      return jsonResponse({ error: "bad data" });
    }
    if (body.hauls.length > MAX_ROWS || body.items.length > MAX_ROWS) {
      return jsonResponse({ error: "too many rows" });
    }
    if (body.calc !== undefined && (typeof body.calc !== "string" || body.calc.length > MAX_CALC)) {
      return jsonResponse({ error: "calculator data too large" });
    }
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      return jsonResponse({ error: "The sheet is busy - try again in a moment." });
    }
    try {
      writeSheet(ss, SHEET_HAULS, body.hauls, HAUL_COLUMNS.concat(HAUL_COMPUTED));
      writeSheet(ss, SHEET_ITEMS, body.items, ITEM_COLUMNS.concat(ITEM_COMPUTED));
      if (typeof body.calc === "string") writeCalc(ss, body.calc);
    } finally {
      lock.releaseLock();
    }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "unknown action" });
}

function readSheet(ss, name, columns) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const timeZone = ss.getSpreadsheetTimeZone();
  const headers = values[0].map(String);
  return values
    .slice(1, MAX_ROWS + 1)
    .filter(function (row) {
      return row.some(function (cell) { return cell !== "" && cell !== null; });
    })
    .map(function (row) {
      const obj = {};
      columns.forEach(function (column) {
        const i = headers.indexOf(column);
        if (i === -1) return;
        let value = row[i];
        if (value === "" || value === null) return;
        if (value instanceof Date) {
          value = Utilities.formatDate(value, timeZone, "yyyy-MM-dd");
        } else if (NUMERIC_COLUMNS.indexOf(column) !== -1) {
          value = Number(value);
          if (!isFinite(value)) return;
        } else {
          value = String(value).slice(0, MAX_TEXT);
        }
        obj[column] = value;
      });
      return obj;
    });
}

function cellValue(value, column) {
  if (value === undefined || value === null) return "";
  if (NUMERIC_COLUMNS.indexOf(column) !== -1) {
    const n = Number(value);
    return isFinite(n) ? n : "";
  }
  let text = String(value).slice(0, MAX_TEXT);
  if (DATE_COLUMNS.indexOf(column) !== -1 && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  // A leading apostrophe makes Sheets store the cell as plain text, so
  // something like "=IMPORTXML(...)" typed as an item name can't run.
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return text;
}

function writeSheet(ss, name, rows, columns) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  if (rows.length === 0) return;
  const data = rows.map(function (row) {
    const safeRow = row && typeof row === "object" ? row : {};
    return columns.map(function (column) { return cellValue(safeRow[column], column); });
  });
  sheet.getRange(2, 1, data.length, columns.length).setValues(data);
}

// The calculator and its saved scenarios are one JSON string, split down column A because it can be
// longer than one cell allows. Each piece starts with "|" so it can never be
// taken for a formula or a number, and is never cut mid-emoji.
function readCalc(ss) {
  const sheet = ss.getSheetByName(SHEET_CALC);
  if (!sheet || sheet.getLastRow() < 2) return "";
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
    .map(function (row) { return String(row[0]); })
    .filter(function (cell) { return cell.charAt(0) === "|"; })
    .map(function (cell) { return cell.slice(1); })
    .join("");
}

function writeCalc(ss, json) {
  let sheet = ss.getSheetByName(SHEET_CALC);
  if (!sheet) sheet = ss.insertSheet(SHEET_CALC);
  sheet.clearContents();
  sheet.getRange(1, 1).setValue("Calculator and saved scenarios from The Real Total - don't edit, it's replaced on every sync.").setFontWeight("bold");
  if (!json) return;
  const rows = [];
  let start = 0;
  while (start < json.length) {
    let end = Math.min(start + CALC_CHUNK, json.length);
    const last = json.charCodeAt(end - 1);
    if (end < json.length && last >= 0xD800 && last <= 0xDBFF) end--;
    rows.push(["|" + json.slice(start, end)]);
    start = end;
  }
  sheet.getRange(2, 1, rows.length, 1).setValues(rows);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
