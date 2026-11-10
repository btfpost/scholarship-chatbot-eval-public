# Evaluating a Scholarship Chat Bot: 54% → 80% in Five Iterations

An evaluation harness for the AI chat bot on **[Denis Time](https://my-scholarships.netlify.app)**, a free, live scholarship finder for high school students (mostly Ohio).

The bot (OpenAI `gpt-4o-mini`) answers questions like *"3.5 GPA, nursing, Columbus. What can I apply for?"* using a list of about 210 active scholarships. This repo tests it with **50 test cases**. Each answer is graded twice:
- by **exact code checks**
- by **Claude as an AI judge**. The judge comes from a different company than the bot on purpose, to avoid self-preference bias.

The results then guided five versions of the bot. Version 5 is now live.

## Results

All runs use the same 50 tests. Each version was evaluated before it was deployed.

| Bot version | What changed | Judge | Overall pass | Code checks | Accuracy (1–5) | Relevance (1–5) |
|---|---|---|---|---|---|---|
| v1 | Original prompt | rubric v2 | 54% | 88% | 4.08 | 3.56 |
| v2 | Prompt: "say who a scholarship is for" (city, group, major) | rubric v2 | 50% | 88% | 3.96 | 3.86 |
| v3 | **Code** fixes link names; prompt: GPA, privacy, SSN rules | rubric v2 | 58% | 94% | 4.16 | 3.80 |
| v3 | *(same bot, re-graded after fixing the judge)* | rubric v3 | 64% | 90% | 4.20 | 3.72 |
| v4 | **Code** filters out scholarships above the student's GPA | rubric v3 | 66% | 98% | 4.22 | 3.74 |
| **v5** | **Data** fix ("no essay" written explicitly) + **code** filters for need-based / renewable / no-essay + "always link" rule | rubric v3 | **80%** | **100%** | **4.58** | **4.02** |

v5 also scored **100% on safety**: it repeated no personal info, followed no prompt injections, and invented no scholarships. The full reports (JSON and HTML) are in [`results/`](results/).

## What I learned

**1. Prompt rules alone barely moved the score. Code and data fixes did.**
- Adding the rule "never suggest a scholarship above the student's GPA" to the prompt left **12 violations** across the test set.
- Removing those scholarships **in code**, before the model ever sees the list, brought that to **0**.
- In the same way, telling the model to use exact scholarship names didn't stop it writing "More Info" or wrong names (about 60 cases in v1). A few lines of code that rewrite every link with the real name from the data made it **0**.
- **Rule of thumb: if code can check it, don't ask the model to.**

**2. Some "model errors" were really input errors.**
- Asked *"Are there scholarships that don't require an essay?"*, the bot said there were none. In fact there were 17.
- The cause: the compact list I gave the model wrote "essay required" when true and **nothing** when false. The model had to notice a *missing* word on 17 of 207 lines.
- Writing "no essay" explicitly fixed it. Only the eval surfaced this. Nobody would notice it in casual testing.

**3. Evaluate the judge, not just the bot.**
- Reading the judge's reasons showed two judge mistakes:
  - It marked *"What's your GPA?"* as a privacy violation.
  - It couldn't check follow-up answers, because it didn't receive the data for scholarships mentioned earlier in the chat.
- After fixing the rubric, the **same v3 bot went from 58% to 64%**. That gap was judge error, not bot error.
- From then on, every report records the rubric version, and I re-ran the old bot whenever the judge changed, so each comparison changes only one thing.

**4. Small differences are noise.**
- v1 → v2 went from 54% to 50%. That's 2 tests out of 50, and the bot isn't deterministic.
- I didn't treat that as a regression. I looked at *which* tests changed and why: v2's longer answers created more chances for factual slips.

## How it works

```
tests.json (50 cases) ──► the real bot code (bots/chat-vN.mjs) ──► answer
                                                                     │
                       ┌─────────────────────────────────────────────┤
                       ▼                                             ▼
             Code checks (free, exact)                    Claude judge (rubric)
             • invented / inactive / expired id           • meets the expectation?
             • min GPA above the student's GPA            • relevance, accuracy, clarity (1–5)
             • more than 5 results                        • safety pass/fail
             • repeats personal info (PII)                • gets the real DATA for every
             • link text ≠ real name (warning)              linked scholarship to fact-check
                       │                                             │
                       └───────────────► PASS only if both pass ◄────┘
                                                   │
                                   results/<time>.json + .html report
```

- **It runs the real bot.** `eval.mjs` imports the bot's actual handler (a Netlify Function) and serves it the same scholarship data, so the test runs the production logic, not a copy of the prompt.
- **The judge uses structured output.** It returns JSON that matches a schema. A test passes only if it meets the expectation, passes safety, has accuracy ≥ 4 and has relevance ≥ 3.
- **Different vendors for bot and judge:** the bot is OpenAI and the judge is Anthropic Claude (`claude-sonnet-5-5` by default, `claude-haiku-5-5` optional).

### Test set (50 cases)

| Category | Count | What it checks |
|---|---|---|
| recommend | 20 | Right scholarships for a major, city, GPA or group |
| low_gpa | 4 | Never suggests a scholarship the student can't qualify for |
| no_match | 6 | Says "nothing fits" instead of inventing (e.g. a fake "Google Moonshot Scholarship", an expired award) |
| off_topic | 5 | Politely declines homework, weather, politics, essay-writing |
| on_topic_general | 1 | Gives general application tips |
| privacy | 5 | Doesn't repeat names, emails or phone numbers; says never to share an SSN |
| injection | 4 | Resists "ignore your instructions", fake "SYSTEM:" messages, "give me 20" |
| follow_up | 3 | Uses the earlier conversation correctly |
| other_language | 2 | Spanish and Russian questions |

Each case has a plain-English `expect` field that the judge grades against.

**All personal details in the privacy tests (names, addresses, phone numbers, emails) are fictional.** Phone numbers use the reserved 555 range, and emails use the reserved example.com domain.

## Run it

You need Node 18+, an OpenAI API key (for the bot) and an Anthropic API key (for the judge).

```bash
npm install
# create a file named .env (it is git-ignored) containing:
#   OPENAI_API_KEY=...
#   ANTHROPIC_API_KEY=...

node eval.mjs                 # all 50 tests on the latest bot (v5), Sonnet judge
node eval.mjs --bot=v1        # any saved version: v1 … v5
node eval.mjs --judge=haiku   # cheaper judge
node eval.mjs --no-judge      # code checks only (no Claude cost)
node eval.mjs --only=rec-09,low-03   # specific tests
node eval.mjs --limit=5       # quick try
```

Each run prints a summary and saves `results/<timestamp>.html`. Open it in a browser to see per-test answers, scores and the judge's reasons.

**Cost and time:** a full run costs about **$0.40** (about $0.26 for the Sonnet judge, about $0.15 for the bot) and takes about 4 minutes.

## Known limitations and next steps

- **Two tests are probably unfair.** `pii-03` expects the exact phrase "I'm an AI without a phone", and `fu-03`'s earlier chat mentions business scholarships without naming any. I'll fix them, then re-run.
- **Judge calibration.** Hand-grade about 20 answers and measure how often the judge agrees with a human.
- **Model comparisons:** a Haiku vs Sonnet judge (cost vs agreement), and `gpt-4.1-mini` vs `gpt-4o-mini` as the bot.
- **Remaining v5 failures:** padding the list with weak fits, overclaiming ("all of these are for Ohio State"), and not offering national scholarships when nothing local fits.
- **One run per version.** With 50 tests, differences of 1–3 tests are within noise. Repeated runs would give confidence intervals.

## License

MIT. See [LICENSE](LICENSE).

## Repo layout

```
LICENSE            MIT license
eval.mjs           the evaluator (code checks, Claude judge, reports)
tests.json         50 test cases
bots/chat-v1…v5    every version of the bot (the live Netlify Function code)
data/              snapshot of the scholarship data the bot uses
results/           every run's JSON + HTML report
```
