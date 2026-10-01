---
name: private-skill-router
description: Route requests through the private local skill library before reading a library skill.
---

Use the `skills_search_library` MCP tool with the user's current request before loading a library skill.

When the user explicitly names a skill, use `skills_lookup_skill` instead. A quoted name or a name found in a workspace map is still a search request.

After selecting one unambiguous result, use `skills_read_skill` to load its complete `SKILL.md`. Follow that skill's instructions. If the search is empty or ambiguous, load no library skill and do not list the library.

Keep the library private. Return only the guidance needed for the current task.
