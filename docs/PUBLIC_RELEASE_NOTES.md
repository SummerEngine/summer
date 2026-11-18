# Writing Summer release notes

A developer reading one entry should know what shipped, who can use it, and what to do next. The headline and opening sentence often travel on their own in search results, social cards, and update prompts. Read them together before reviewing the bullets.

## Choose the length

| Release | What to write |
| --- | --- |
| Fix or maintenance update | One sentence naming the symptom, when it occurred, and what the user now sees. A single fix can be the whole entry. |
| Feature release | Lead with a task the reader can now complete. Give the shortest path to try it and group related fixes underneath. |
| Major launch | Open with the new workflow. Walk through one real example and link to the download, playable result, or guide. Call out who has access and any upgrade steps. |

For the full changelog, compare the previous and current shipped revisions for each platform. Keep the opening short and give each distinct user-visible fix room in the details. Record the source comparisons in review so the next editor can check coverage.

## Score the draft out of ten

Score each row **0** when the answer is missing or wrong, **1** when the reader has to infer it, and **2** when the copy makes it clear. Aim for **9/10**. An incorrect version, platform, availability, or capability always needs correction regardless of score. The score belongs in review.

| Points | Question for the editor |
| --- | --- |
| 0–2 | **Outcome.** Can a reader say what they can now do, or which failure they will stop seeing, from the headline and first sentence? |
| 0–2 | **Availability.** Can they identify the product, shipped version, date, and applicable platform or audience from the entry and its labels? |
| 0–2 | **Evidence.** Can the editor trace each claim to the released build, package, or verified workflow? Give readers a real command, menu path, observed result, or relevant link. |
| 0–2 | **Limits and action.** Can a reader tell whether access, setup, migration, or a known limitation affects them? Attach each qualification to the specific feature and audience. An ordinary fix can earn full marks without a caveat. |
| 0–2 | **Clarity.** Can someone quote the opening on its own and understand it? Use product names and concrete verbs. Trim repeated platform prefixes, internal milestones, and unsupported superlatives. |

## Describe availability precisely

Lead with the launch. Say what shipped and show the reader how to use it. “Launched” and “is live” are appropriate for released work. A feature can be new and still earn a direct announcement. Describe any material access, platform, publishing, or migration boundary in the sentence about that feature. Use a formal maturity label when it identifies a channel or commitment a developer needs to choose. Terms such as “preview a build” and the `summer preview` command describe actions.

## A worked example

> **Build and play a web game beside your chat**
>
> In Summer Engine 0.8.7 for Windows, choose **Web-only game** under **New game**. Play in the **Web** tab beside your chat and watch the game reload as your agent edits it.

The Windows release supported creating and playing these projects locally. That scope belongs beside the steps. A general warning about early software gives the reader less information. [Windows release notes](https://www.summerengine.com/changelog/0.8.7)

## Reuse across channels

Use the same release facts in the website entry, docs timeline, updater, and GitHub Release. Adapt the detail to the reader. On the website, write the first highlight as a standalone sentence. In docs, give the steps or command. In the updater, show the changes for the recipient’s platform. For the CLI and MCP, name the package and keep exact commands, compatibility details, and upgrade instructions with the versioned entry. Historical entries describe availability on their release date.
