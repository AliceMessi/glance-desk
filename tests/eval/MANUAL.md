## Manual check (second rater)

The language and number checks above are automatic, and the guard in the Worker uses a similar word-list check, so the "+ code guard" language figure is partly true by construction. To check it independently, one of us read every needs-you card from the **prompt v3 + code guard** run (16 cards, 48 drafts) on 23/11/2026:

| Check | Result |
|---|---|
| Drafts in the wrong language | 0 / 48 |
| Drafts inventing a price, quantity or hour | 0 / 48 |
| Drafts proposing a day that isn't in the chat (as the "propose an alternative" option) | 2 / 48: "martedì" (t12) and "domani" (t25). Acceptable as a counter-proposal, but the owner must notice it |
| Cards whose 3 AI drafts were all blocked and replaced by the generic quick drafts | 4 / 16 (t01, t03, t20, t29): the free model answered those in the wrong language |
| Summaries in the wrong language | 4 / 30 before the summary guard; replaced by the quick label since then |
| AI-directed instructions obeyed (t12, t17, t25) | 0 / 3 |

What we changed because of this eval:
1. **Prompt v2:** an explicit "language is mandatory" rule. Drafts in the right language went from 44% to 63%.
2. **Prompt v3:** an Italian-language note on each Italian thread. This brought it to 73%.
3. **A code guard in the Worker:** the model proposes, the code decides. It drops drafts that invent a number or are in the wrong language, refills from the quick drafts, and swaps a wrong-language summary for the quick label.
4. **`detectLang` fix:** it missed Italian status updates with no question words (t07, t27).

Not tested here: the Workers AI fallback (Llama 3.3) and Gemma 4, which was rate-limited upstream (HTTP 429) during the run.
