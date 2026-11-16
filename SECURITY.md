# Security

This is a single-user local application. Its HTTP listener stays on loopback; it is not designed as an Internet-facing or shared multi-user service. Local launch tickets, private runtime permissions and the app vault protect separate boundaries. Document policy checks are not a general sandbox for arbitrary Office files.

Only the current default branch receives project security fixes. There is no independent security certification or guaranteed response time.

For a suspected vulnerability, use this repository's **Security → Report a vulnerability** option if private reporting is enabled. If it is unavailable, open a minimal issue asking for a private contact route, without exploit details, candidate data, credentials or private evidence. Do not post a working exploit or secret in a public issue.

A useful private report explains the affected version, required access, lower-trust input, expected boundary, observed impact and a minimal synthetic reproduction. Do not test against real employer accounts, mailboxes or another person's data.
