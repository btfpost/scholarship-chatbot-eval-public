// Denis Time chat bot: the "hidden helper" (a Netlify Function).
// Runs on Netlify's servers, never in the visitor's browser.
// The OpenAI key comes from the Netlify environment variable OPENAI_API_KEY
// and is never sent to the browser.

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_QUESTION_CHARS = 500;   // longest question a visitor can send
const MAX_HISTORY = 6;            // how many earlier messages are sent along
const MAX_ANSWER_TOKENS = 500;    // keeps answers short and cheap
const RATE_LIMIT = 20;            // questions per visitor...
const RATE_WINDOW_MS = 10 * 60 * 1000; // ...per 10 minutes

// Sites allowed to use this helper (the live site, Netlify previews, local testing)
const ALLOWED_ORIGINS = [
  /^https:\/\/my-scholarships\.netlify\.app$/,
  /^https:\/\/[a-z0-9-]+--my-scholarships\.netlify\.app$/,
  /^http:\/\/localhost(:\d+)?$/,
];

// Simple per-visitor counter. Best effort: it resets when Netlify restarts the
// function. The real safety net is the monthly budget on the OpenAI project.
const hits = new Map();

function tooManyRequests(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Turn the big scholarship file into a short list the AI can read cheaply.
// Skips inactive scholarships and ones whose deadline has passed.
function compactList(all) {
  const today = new Date().toISOString().slice(0, 10);
  return all
    .filter((s) => s.active && !(s.deadline && s.deadline < today))
    .map((s) => {
      const e = s.eligibility || {};
      const parts = [
        `id=${s.id}`,
        s.name,
        `by ${s.organization}`,
        `amount: ${s.amount_display || s.amount}`,
        `deadline: ${s.deadline || "rolling/unknown"}`,
        e.min_gpa ? `min GPA ${e.min_gpa}` : "no GPA minimum listed",
        e.need_based ? "need-based" : "merit/other",
        e.majors && e.majors.length ? `majors: ${e.majors.join(", ")}` : "any major",
        s.city ? `city: ${s.city}` : null,
        s.state ? `state: ${s.state}` : (s.locality === "national" ? "national" : null),
        e.demographics && e.demographics.length ? `for: ${e.demographics.join(", ")}` : null,
        s.essay_required ? "essay required" : null,
        s.renewable ? "renewable" : null,
        s.description ? `about: ${String(s.description).slice(0, 140)}` : null,
      ];
      return { minGpa: Number(e.min_gpa) || 0, line: parts.filter(Boolean).join(" | ") };
    });
}

// Find the student's GPA in what they wrote ("3.5 GPA", "GPA is only 2.0", "мой GPA 3.7").
// Looks at the newest messages first. Returns null if no GPA was given.
function findGpa(texts) {
  for (const t of [...texts].reverse()) {
    const m = String(t).match(/gpa\D{0,15}?([0-4](?:\.\d{1,2})?)(?!\d)/i)
      || String(t).match(/(?<![\d.])([0-4]\.\d{1,2})\s*(?:gpa|average)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

// Code (not AI) removes scholarships whose minimum GPA is above the student's GPA,
// so the AI can't suggest them.
function listFor(entries, gpa) {
  const keep = gpa == null ? entries : entries.filter((x) => x.minGpa <= gpa);
  return keep.map((x) => x.line).join("\n");
}

let cachedList = null;
let namesById = null; // id -> real scholarship name, used to fix link text
// cachedList is an array of {minGpa, line}; listFor() turns it into text per question.

async function getList(siteUrl) {
  if (cachedList) return cachedList;
  const res = await fetch(new URL("/data/scholarships.json", siteUrl));
  if (!res.ok) throw new Error("Could not load scholarships.json");
  const all = await res.json();
  namesById = new Map(all.map((s) => [String(s.id), s.name]));
  cachedList = compactList(all);
  return cachedList;
}

// The AI sometimes writes "More Info" or a wrong name as link text.
// Code (not AI) replaces every link's text with the real name from the data.
function fixLinkNames(answer) {
  if (!namesById) return answer;
  return answer.replace(/\[([^\]]*)\]\(scholarship\?id=(\d+)\)/g, (whole, text, id) => {
    const name = namesById.get(id);
    return name ? `[${name}](scholarship?id=${id})` : whole;
  });
}

function systemPrompt(list, gpa) {
  const today = new Date().toISOString().slice(0, 10);
  const gpaNote = gpa == null ? "" : `\nThe student's GPA is ${gpa}. The LIST below already contains only scholarships they qualify for by GPA. Don't mention scholarships that are not in it.\n`;
  return `You are the friendly helper on "Denis Time", a free scholarship finder for high school students (mostly in Ohio). Today is ${today}.
${gpaNote}

RULES:
- Recommend ONLY scholarships from the LIST below. Never invent scholarships, amounts, deadlines or requirements. If nothing fits, say so and suggest using the site's filters.
- When you mention a scholarship, link it exactly like this: [Scholarship Name](scholarship?id=ID) using its id from the list.
- Keep answers short: at most 5 scholarships, with amount and deadline for each.
- If the student gives a GPA, NEVER suggest a scholarship whose "min GPA" in the list is higher than their GPA. Check each one before you include it. Scholarships with "no GPA minimum listed" are fine. It is OK to suggest fewer than 5.
- Only state facts (eligibility, need-based, majors, cities) that are written in that scholarship's line in the list. Don't guess.
- If a scholarship is limited to a different city or area than the student's (for example a Cleveland foundation for a Columbus student), you may still include it, but add a clear note saying who it is for, e.g. "Mainly for Greater Cleveland students. Check their site to see if any fund fits you." Do the same for other limits the student may not meet (e.g. women only, a specific major, a specific group).
- Never ask for the student's name, email, address, phone, school or other personal details. If they share them, don't repeat them (not even their first name).
- If asked whether they need to share a Social Security number, bank details or passwords, answer clearly: "No. Never share that here." (You may add that only an official application form, never a chat, should ask for an SSN.)
- Only help with scholarships, college costs and applying. Politely decline anything else.
- Remind students to check the official scholarship website for the final rules when it matters.
- Write in simple, encouraging language for a teenager.

LIST (one scholarship per line):
${list}`;
}

export default async (req, context) => {
  if (req.method !== "POST") return reply(405, { error: "Use POST." });

  const origin = req.headers.get("origin") || "";
  if (!ALLOWED_ORIGINS.some((re) => re.test(origin))) {
    return reply(403, { error: "Not allowed." });
  }

  if (tooManyRequests(context.ip || "unknown")) {
    return reply(429, { error: "You're asking very fast! Please wait a few minutes and try again." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return reply(500, { error: "The chat helper isn't set up yet (missing key)." });

  let body;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "Bad request." });
  }

  const question = String(body.message || "").trim();
  if (!question) return reply(400, { error: "Please type a question." });
  if (question.length > MAX_QUESTION_CHARS) {
    return reply(400, { error: `Please keep your question under ${MAX_QUESTION_CHARS} characters.` });
  }

  // Earlier messages from this chat (only kept in the visitor's browser).
  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-MAX_HISTORY)
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 1500) }));

  try {
    const entries = await getList(req.url);
    const gpa = findGpa([...history.filter((m) => m.role === "user").map((m) => m.content), question]);
    const list = listFor(entries, gpa);
    const ai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_ANSWER_TOKENS,
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt(list, gpa) },
          ...history,
          { role: "user", content: question },
        ],
      }),
    });

    if (!ai.ok) {
      console.error("OpenAI error", ai.status, await ai.text());
      return reply(502, { error: "The helper is having trouble right now. Please try again later." });
    }

    const data = await ai.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't come up with an answer.";
    const answer = fixLinkNames(raw);
    return reply(200, { answer });
  } catch (err) {
    console.error(err);
    return reply(500, { error: "Something went wrong. Please try again later." });
  }
};

export const config = { path: "/api/chat" };
