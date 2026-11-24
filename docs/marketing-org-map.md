# Map a marketing org

[← README](../README.md) · [Accounts](accounts.md)


For one account, the **Marketing org** view (switch at the top of the org chart) shows everyone in marketing, how big
the team is, how it's structured (sub-functions, teams, legal entities, a reporting tree) and what each person does.
Every inferred fact shows where it came from and how sure it is. Everything uses free sources: your browser, and web
search and Claude through your own Claude Code login.

1. **Headcount.** Open the company's **People** tab on LinkedIn, *without* a keyword search. Make the member count and
   the **What they do** box visible, then click **⇣ Map to Network Builder → Capture headcount only**. It saves
   "N associated members" and the visible What they do counts (Marketing, Sales, …) and reads no people.
   LinkedIn's People tab now lists only the **top 5** "What they do" functions (no Show more), and its job-function
   filter doesn't filter the page. So the LinkedIn marketing count exists only when Marketing is in that top 5;
   otherwise the map shows the company total and no coverage percentage. (LinkedIn Premium's company **Insights** tab
   shows headcount by function; it could be a future source, but nothing reads it today.)
2. **Walk the people.** Run a LinkedIn people search for the team (e.g. *marketing*, *Kommunikation*, *brand*, filtered
   to the company) and click **Start mapping**. Each named row becomes a light contact on the account; "LinkedIn
   Member" rows are only counted.
   - LinkedIn now sends a keyword search on a company's People tab to the people search results (10 per page with a
     **Next** button). Those pages show no results count, which is why the headcount comes from step 1. Filtering the
     People tab by keyword just redirects, so walk the search instead.
   - **Group companies** have a LinkedIn page per entity. Do steps 1 and 2 for each entity page and pick the same
     account each time; the counts add up and entities are kept apart.
3. **✦ Classify & suggest reporting lines.** In the Marketing org view. Claude (Haiku) sorts everyone into
   sub-functions and seniority, flags noise (HR/employer marketing, sales hybrids, people at another employer; a
   vendor-funded marketer stays in the org with a tag) and suggests who reports to whom, with a confidence and a reason.
4. **🌐 Research on the web.** Searches company pages, press releases, job ads and interviews (never LinkedIn) for the
   marketing leaders, team structure, entities and "reports to" statements. Each finding needs an evidence URL and a
   quote. It backs off when web search is rate-limited and waits for you to **Resume**.
5. **Confirm the lines.** Suggested lines are dashed, with a confidence badge and reason. **✓ Confirm**, **Change…** or
   **↺** each one; your choice always wins over later suggestions. Fix anyone's sub-function, team, entity or "in the
   org?" in their drawer.

Then ask Claude: *"Summarise Ledgerly's marketing org and who we should talk to"*. `network_get_org_map` returns the
tree (each line tagged `[confirmed]`, `[inferred 0.6]` or `[web 0.9]`), headcounts captured vs LinkedIn, sub-functions,
flagged people and evidence.

**Costs** (measured in live tests): classifying 48 people cost about **$0.02**; web research cost about **$0.21** for
two passes, and a full run is estimated at **$0.30–1.40** per account. Both show an estimate and ask before they start.
The LinkedIn steps cost nothing.

**LinkedIn risk.** LinkedIn's terms restrict automated browsing and it may limit accounts that browse a lot. The walk is
capped (300 rows a run by default, 500 max, 1,000 a day), runs only in the visible tab after your click, at human pace,
and stops on any security check. Map one team at a time and stop if you see a check.

**GDPR and privacy.** The org map is personal data about people who didn't sign up for it:
- It stays local, in your SQLite file. Classification sends titles only (no names); web research sends the company
  and the people already known, and keeps only what public pages state, each with its source.
- It only uses what is visible to you: list rows on your screen and public web pages with a source link. No hidden
  fields, no paid data brokers, no enrichment of emails or phone numbers.
- When you contact someone you found this way, tell them where you got their details (GDPR Art. 14). If they object,
  remove them from the account; a later list walk can add them again, so check after re-walking.

