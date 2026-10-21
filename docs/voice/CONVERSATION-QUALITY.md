# Natural kitchen conversation acceptance

The cloud speech-to-speech LLM chooses its wording and follow-ups from context. The application controls food identity, measurements, calculations, visible choices and confirmed writes. Nutrition knowledge retrieval supplies evidence; it is not a dialogue script.

The revised session instructions remove the requirement to immediately read every card whenever a food is mentioned. They ask the model to establish intent, retain supplied details, resolve important ambiguities and use catalog searches when useful. No canned chicken interview or FAQ response engine has been added.

## Behavioral examples to test live

Score the behavior, not an exact answer string. Ask questions in different orders, interrupt, and volunteer several details together. These are test inputs, not production scripts.

| Situation | Expected behavior |
| --- | --- |
| “I'm having chicken.” | If logging is intended, clarify the missing cut/preparation naturally; do not silently pick a generic chicken record. |
| “Log skinless grilled chicken breast.” | Retain cut, skin and method; do not re-ask them. Establish portion/weight basis as needed. |
| “It's thighs, actually.” | Apply the correction to the pending choice, not a saved meal; refresh candidates when needed. |
| “Grilled.” after “chicken breast” | Treat grilled as cooked, retain breast, ask only remaining important details. |
| “I weighed it before grilling.” | Use a defensible raw-weight basis or clarify; do not pair raw grams with cooked nutrition. |
| “Two hundred grams after cooking.” | Use the spoken-portion tool with the correct cooked candidate. Never claim the scale measured it. |
| “I used a tablespoon of oil.” | Identify the oil and defensible portion; do not pretend the chicken entry automatically contains it. |
| “The packaged chicken already includes the sauce.” | Avoid logging the same sauce twice. |
| “I don't know the cut.” | Acknowledge uncertainty; do not claim a precise match without evidence. |
| “Why does chicken have protein?” | Give a grounded explanation without starting a logging interview. |
| “What should I eat?” | Read current state and validated guidance; do not demand a product-card choice first. |
| “Show the options.” | Present actual available cards, briefly explain differences, allow voice selection. |
| “Pick option B.” | Select the same currently displayed B; never use an old offer. |
| “The second one—no, the first.” | Clarify the corrected choice if transcription is ambiguous; do not save. |
| “Never mind.” | Cancel the pending flow without deleting prior logs. |
| “Rice, 150 grams.” | Clarify cooked versus dry if not established. |
| “The same yogurt, vanilla this time.” | Preserve relevant context but resolve the changed variant; do not reuse plain yogurt facts. |
| “That's all I know.” | Offer an honest available next step; avoid repeatedly asking the same question. |
| User interrupts while MACROS describes cards | Stop speaking, listen, and continue from the correction. |
| Unknown food or incompatible catalog match | Say that a suitable match is unavailable; do not invent nutrition values. |

## Pass criteria and present limits

Before pilot use, run these scenarios with real speech, at least two phrasings per scenario, and varied order/noise. Record whether the assistant understood intent, retained details, avoided redundant questions, selected the right food/basis, acknowledged uncertainty and respected interruptions. Require zero unauthorized/duplicate saves and zero silent raw/cooked or cut substitutions in this evaluation. Review failures before expanding the pilot.

Status: instructions updated and the existing tool/confirmation behavior is covered by automated tests. These live conversational outcomes have NOT yet been measured. Without provider credit, touch testing and injected transcript tests cannot establish natural timing, accurate speech interpretation or conversational reasoning quality. The current shared USDA demo allowance also limits new grocery searches. A broader food catalog remains a separate workstream.
