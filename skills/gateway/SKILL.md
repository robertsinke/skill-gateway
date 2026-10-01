---
name: search-skills
description: The skill library shortlist is injected with each user message. Load a library skill only from that list. An empty list means load no library skill.
---

# Search skills

A userPromptSubmit hook already searched the local skill library for this user message and injected the shortlist, including the command to search again. Load a library skill only from that list. Do not search before skills already loaded, including `open-knowledge` and product or plugin skills.

The same command is how you search again at will. During this same user message, run it with `--limit 10`. When the shortlist is missing, run the library directly:

```bash
node ~/.local/share/skill-gateway/dist/search.js "<user message>" --limit 20
```

Pass the user message as the query. Do not pass the workspace routing table. Do not paraphrase the message. A repeat search during that same user message uses `--limit 10`. The next user message uses 20 again. Paths already returned stay loadable after the tighter search.

When the user names the skill, run:

```bash
node ~/.local/share/skill-gateway/dist/search.js --exact "<name>"
```

A quoted name is not a lookup. A name that only appears in the workspace map is not a lookup. Search for that capability instead.

Each result has a name, a directory path, a description, and a score. Read the printed path and follow that skill.

An empty result means load no library skill. A failed run means load no library skill. Do not list the library. Do not call marketplace search. Marketplace search looks up skills.sh, not this library.
