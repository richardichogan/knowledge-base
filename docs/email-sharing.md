# SMTP2GO sharing

Athena supports **manual, review-before-send** email sharing from:

- A successful diagram export to Mural: **Share Mural link by email**.
- A diagram's Export menu: **Share draw.io attachment by email**.
- A Think note's Export menu: **Share GitHub note by email**, after publishing the note to GitHub.

No email is sent automatically on export, publication or save. The composer shows the exact link or attachment, recipients, subject and message before **Send email**.

## Setup

In **Sources / Integrations**, open **SMTP2GO sharing** and save an SMTP2GO SMTP username/password. These are SMTP credentials, not the SMTP2GO dashboard login or API key. Credentials are encrypted at rest using Athena's existing credential-encryption key; passwords are never returned to the browser. Leaving the password blank when editing retains the saved password.

The fixed sender is **Athena &lt;share@athena.themicrosoftcloudblog.com&gt;**. Verify `athena.themicrosoftcloudblog.com` in SMTP2GO and publish the DNS records SMTP2GO supplies. A mailbox at that address is **not required for sending**. Set the optional **Reply-To** to an existing mailbox if replies should reach someone.

Athena connects to `mail-eu.smtp2go.com:2525`, requiring STARTTLS and normal certificate verification. **Check connection (no email)** authenticates with SMTP2GO but does not send a message, verify sender-domain DNS or prove inbox delivery. No additional Azure SMTP environment variables are needed. The backend's existing `CREDENTIAL_ENCRYPTION_KEY` (or supported credential-key fallback) must be configured; email sharing does not use the newsletter SMTP defaults.

## Limits and access

Each email supports 1–20 recipients, a 200-character subject, a 10,000-character message, and an optional draw.io XML attachment up to **4 MiB**. The diagram attachment uses the existing draw.io export, including selected footnotes/legend and embedded assets. Larger diagrams must be reduced or shared by link. All recipients are Bcc; they cannot see each other's addresses. Only individual Mural board links and GitHub Markdown file links are accepted.

Sharing a link does **not** grant access to a private board or repository. Think sharing sends the **published GitHub version**, not unsaved/unpublished edits, and does not publish automatically.

GitHub notes support outbound publishing and explicit conflict resolution: external GitHub changes pause publishing until you choose the Think or GitHub version. This is not automatic two-way merging.

## Submission and retries

Athena reports SMTP2GO's accepted/rejected recipient counts. Acceptance confirms submission, **not inbox delivery**. Check SMTP2GO activity for delivery, bounces or partial rejection.

Each send has a persistent, user-scoped request identifier. Repeating the same request returns its recorded accepted result rather than resending. While a request is pending or its outcome is uncertain, it cannot be sent again with that identifier. An explicit composer retry reuses the exact request; there are no automatic SMTP retries.

If the network fails or the outcome cannot be saved, check SMTP2GO activity before composing a new copy. A new composer creates a new request and could otherwise duplicate a message already submitted. The duplicate-protection record contains a content fingerprint and counts, not recipient addresses, message text or attachment contents.
