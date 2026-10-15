// Local Flow — dates typed in plain words, as in Todoist: "tomorrow 18:00", "fri", "in 3 days",
// "24.03.2024", "завтра в 10:00", "в пятницу", "через неделю". Used by the Outline editor to find
// such a phrase in an item's text (it becomes the item's "by" deadline) and by its date picker.
// A plain script that sets window.LFWhen; tests load it the same way.

(function (g) {
  "use strict";

  const pad = (n) => String(n).padStart(2, "0");
  const fmtDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  // Words, longest first inside each group so that "tues" wins over "tue".
  const WEEKDAYS = [
    // Sunday = 0, as Date.getDay().
    ["sunday", "sun", "воскресенье", "вс"],
    ["monday", "mon", "понедельник", "пн"],
    ["tuesday", "tues", "tue", "вторник", "вт"],
    ["wednesday", "wed", "среду", "среда", "ср"],
    ["thursday", "thurs", "thur", "thu", "четверг", "чт"],
    ["friday", "fri", "пятницу", "пятница", "пт"],
    ["saturday", "sat", "субботу", "суббота", "сб"],
  ];
  const MONTH_WORDS = [
    ["january", "jan", "января", "январь", "янв"],
    ["february", "feb", "февраля", "февраль", "фев"],
    ["march", "mar", "марта", "март", "мар"],
    ["april", "apr", "апреля", "апрель", "апр"],
    ["may", "мая", "май"],
    ["june", "jun", "июня", "июнь", "июн"],
    ["july", "jul", "июля", "июль", "июл"],
    ["august", "aug", "августа", "август", "авг"],
    ["september", "sept", "sep", "сентября", "сентябрь", "сент", "сен"],
    ["october", "oct", "октября", "октябрь", "окт"],
    ["november", "nov", "ноября", "ноябрь", "ноя"],
    ["december", "dec", "декабря", "декабрь", "дек"],
  ];
  const alt = (groups) => groups.flat().sort((a, b) => b.length - a.length).join("|");
  const indexIn = (groups, word) => groups.findIndex((g2) => g2.includes(word.toLowerCase()));

  const WD = alt(WEEKDAYS);
  const MON = alt(MONTH_WORDS);
  // A time of day: "18:00", "9:30", "6pm", "6:30 pm", "at 18:00", "в 18:00", "@18:00".
  const TIME = `(?:(?:at|в|@)\\s*)?(?:(\\d{1,2}):(\\d{2})(?:\\s*([ap])\\.?m\\.?)?|(\\d{1,2})\\s*([ap])\\.?m\\.?)`;
  const UNITS = "minutes|minute|mins|min|hours|hour|hrs|hr|days|day|weeks|week|минуту|минуты|минут|час|часа|часов|день|дня|дней|неделю|недели|недель";
  // The day part, each alternative in its own group (see dayOf).
  const DAY = [
    "(day after tomorrow|послезавтра)",
    "(today|tonight|сегодня)",
    "(tomorrow|tmrw|tmr|завтра)",
    "(next week|на следующей неделе|следующей неделе)",
    `(?:(?:next|this|on|в|во|до|к|ко|by)\\s+)?(${WD})`,
    `(?:in|через)\\s+(\\d+|an?|один|одну)?\\s*(${UNITS})`,
    "\\+(\\d+)\\s*([mhdw])",
    "(\\d{4})-(\\d{2})-(\\d{2})",
    "(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}|\\d{2}))?",
    `(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})(?:\\s+(\\d{4}))?`,
    `(${MON})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`,
    "(eod|end of day|конец дня|к концу дня)",
  ];
  const DAY_RE = DAY.map((d) => `(?:${d})`).join("|");
  // The groups each alternative of DAY has, to find which one matched.
  const GROUPS = DAY.map((d) => new RegExp(`${d}|`).exec("").length - 1);
  const TIME_GROUPS = 5;
  // A phrase stands alone: not inside a word or a number ("iOS 26.1.3", "v2.10" are not dates).
  const L = "(?<![\\p{L}\\p{N}.:/-])";
  const R = "(?![\\p{L}\\p{N}'’:/\\-–]|\\.\\d)";
  const PHRASE = new RegExp(
    `${L}(?:(?:by|до|к|on)\\s+)?(?:(?:${DAY_RE})(?:,?\\s+${TIME})?|${TIME}(?:\\s+(?:${DAY_RE}))?)${R}`, "giu");

  /** The time of day from TIME's groups, as [h, m], or null. */
  function timeOf(m) {
    if (m[0] !== undefined) {
      let h = Number(m[0]);
      const min = Number(m[1]);
      if (m[2]) { if (h > 12 || h === 0) return false; h = (h % 12) + (m[2].toLowerCase() === "p" ? 12 : 0); }
      return h > 23 || min > 59 ? false : [h, min];
    }
    if (m[3] !== undefined) {
      const h = Number(m[3]);
      if (h > 12 || h === 0) return false;
      return [(h % 12) + (m[4].toLowerCase() === "p" ? 12 : 0), 0];
    }
    return null;
  }

  /** The day (a Date at midnight) and a default time from DAY's groups; false when it is no date. */
  function dayOf(which, m, now, workdayEnd) {
    const today = midnight(now);
    const word = (m[0] || "").toLowerCase();
    switch (which) {
      case 0: return { day: addDays(today, 2) };
      case 1: return { day: today, time: word === "tonight" ? [20, 0] : null };
      case 2: return { day: addDays(today, 1) };
      case 3: return { day: addDays(today, ((8 - today.getDay()) % 7) || 7) };
      case 4: {
        const wd = indexIn(WEEKDAYS, word);
        // The next such day after today ("fri" on a Friday is the next one).
        return { day: addDays(today, ((wd - today.getDay() + 7) % 7) || 7) };
      }
      case 5: {
        const raw = (m[0] || "1").toLowerCase();
        const n = /^\d+$/.test(raw) ? Number(raw) : 1;
        const unit = m[1].toLowerCase();
        if (/^(min|мин)/.test(unit)) return { at: new Date(now.getTime() + n * 60000) };
        if (/^(h|час)/.test(unit)) return { at: new Date(now.getTime() + n * 3600000) };
        if (/^(w|нед)/.test(unit)) return { day: addDays(today, 7 * n) };
        return { day: addDays(today, n) };
      }
      case 6: {
        const n = Number(m[0]);
        const u = m[1].toLowerCase();
        if (u === "m") return { at: new Date(now.getTime() + n * 60000) };
        if (u === "h") return { at: new Date(now.getTime() + n * 3600000) };
        return { day: addDays(today, u === "w" ? 7 * n : n) };
      }
      case 7: return { day: ymd(Number(m[0]), Number(m[1]), Number(m[2])) };
      case 8: {
        // "24.03" without a year: this year, or next year when it is already past.
        // The month has two digits unless the year has four: "24.03" and "2.1.2027" are dates,
        // "1.5", "26.1" and "2.1.10" are numbers.
        if (m[1].length < 2 && !(m[2] && m[2].length === 4)) return false;
        const y = m[2] === undefined ? null : m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
        return { day: ymd(y, Number(m[1]), Number(m[0]), today) };
      }
      case 9: return { day: ymd(m[2] ? Number(m[2]) : null, indexIn(MONTH_WORDS, m[1]) + 1, Number(m[0]), today) };
      case 10: return { day: ymd(m[2] ? Number(m[2]) : null, indexIn(MONTH_WORDS, m[0]) + 1, Number(m[1]), today) };
      case 11: {
        const [h, min] = workdayEnd.split(":").map(Number);
        return { day: today, time: [h, min] };
      }
      default: return false;
    }
  }

  /** A real date or false; without a year, the next time that day comes (today included). */
  function ymd(y, mo, d, today) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const make = (year) => { const t = new Date(year, mo - 1, d); return t.getMonth() === mo - 1 ? t : false; };
    if (y !== null && y !== undefined) return make(y);
    const t = make(today.getFullYear());
    if (t && t < today) return make(today.getFullYear() + 1);
    return t;
  }

  /** The due string ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM") a match stands for, or null. */
  function dueOf(groups, now, workdayEnd) {
    // groups: everything after the whole match. Layout: DAY groups, TIME groups, TIME groups, DAY groups.
    let i = 0;
    const take = (n) => { const s = groups.slice(i, i + n); i += n; return s; };
    const dayParts = GROUPS.map((n) => take(n));
    const time1 = take(TIME_GROUPS);
    const time2 = take(TIME_GROUPS);
    const dayParts2 = GROUPS.map((n) => take(n));
    const pick = (parts) => { const k = parts.findIndex((p) => p.some((x) => x !== undefined)); return k < 0 ? null : { k, m: parts[k] }; };
    const d = pick(dayParts) || pick(dayParts2);
    const t = timeOf(time1.some((x) => x !== undefined) ? time1 : time2);
    if (t === false) return null;
    if (!d) {
      if (!t) return null;
      // A time alone: today, or tomorrow when it has passed.
      let at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t[0], t[1]);
      if (at <= now) at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, t[0], t[1]);
      return stamp(at);
    }
    const r = dayOf(d.k, d.m, now, workdayEnd);
    if (!r) return null;
    if (r.at) return stamp(r.at);
    if (!r.day) return null;
    const time = t || r.time;
    return time ? `${fmtDay(r.day)} ${pad(time[0])}:${pad(time[1])}` : fmtDay(r.day);
  }

  const stamp = (d) => `${fmtDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

  /**
   * The first date phrase in `text`: { start, end, phrase, due }, or null. `skip` is a list of
   * phrases the user said are not dates (they are passed over).
   */
  function find(text, now = new Date(), opts = {}) {
    const workdayEnd = opts.workdayEnd || "18:00";
    const skip = new Set((opts.skip || []).map((s) => s.toLowerCase()));
    PHRASE.lastIndex = 0;
    let m;
    while ((m = PHRASE.exec(text))) {
      if (!m[0]) { PHRASE.lastIndex++; continue; }
      const phrase = m[0].trim();
      if (skip.has(phrase.toLowerCase())) continue;
      // In running text these are words too ("sat with Tom"): a date only after on/by/next/this.
      if (!opts.loose && /^(sat|sun|wed|mon)$/i.test(phrase.split(/[\s,]/)[0])) continue;
      const due = dueOf(m.slice(1), now, workdayEnd);
      if (due) return { start: m.index, end: m.index + m[0].length, phrase, due };
    }
    return null;
  }

  /** The whole of `input` read as a date ("" and unreadable give null). */
  function parse(input, now = new Date(), opts = {}) {
    const s = String(input || "").trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2})?$/.test(s)) return s.replace(/ (\d):/, " 0$1:");
    const f = find(s, now, { ...opts, loose: true });
    return f && f.start === 0 && f.end === s.length ? f.due : null;
  }

  /** `text` without the phrase found in it, the spaces around it closed up. */
  function cut(text, f) {
    return (text.slice(0, f.start).replace(/[\s,]+$/, "") + " " + text.slice(f.end).replace(/^[\s,]+/, "")).trim();
  }

  /** "Thu 16 Oct 18:00", "today", "tomorrow 9:00", "Wed 24 Mar 2027"; `plain`: never "today"/"tomorrow". */
  function label(due, now = new Date(), opts = {}) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2}))?$/.exec(due || "");
    if (!m) return due || "";
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const days = Math.round((d - midnight(now)) / 86400000);
    const time = m[4] !== undefined ? ` ${pad(Number(m[4]))}:${m[5]}` : "";
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (!opts.plain && days === 0) return `today${time}`;
    if (!opts.plain && days === 1) return `tomorrow${time}`;
    if (!opts.plain && days === -1) return `yesterday${time}`;
    const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : "";
    return `${names[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}${year}${time}`;
  }

  g.LFWhen = { find, parse, cut, label, fmtDay };
})(globalThis);
