import type { LegalSection } from "./site-details";
export const privacySections: LegalSection[] = [
  {
    "id": "operator",
    "title": "Who is responsible",
    "paragraphs": [
      "Tomasz Szymański operates ChessHub and is responsible for the personal data processed for this project. Contact: tszymans@student.42warsaw.pl. ChessHub is an educational ft_transcendence project hosted on a local computer for development, testing and school evaluation. It is not a publicly offered website. 42 school is not identified as the operator by this notice."
    ]
  },
  {
    "id": "data",
    "title": "Information we process",
    "paragraphs": [
      "Accounts contain an email address, username, password hash, identifier, role, status, rating and timestamps. Passwords are verified using hashes, not stored as readable passwords. Sessions contain an account link, hashed session token and creation/expiry times. Friends records contain participants, requester, relationship state and dates; connection state supports online presence. Chess records may include players, moves, results, game notation, time controls and rating changes. Tournaments record creators, descriptions, registrations, seeds, check-ins, invitations and bracket results. API access records include the key owner, key hash and lifecycle metadata."
    ]
  },
  {
    "id": "purposes",
    "title": "Purposes and legal bases",
    "paragraphs": [
      "We process information necessary to provide the account and chess functions you request, including friends and tournaments, on the basis of performing our service arrangement with you. We process proportionate connection, session, error and abuse-prevention information for our legitimate interests in securing and maintaining the local educational service. These interests are balanced against users’ privacy rights. Optional AI assistance is processed to provide the assistance you request. We do not treat reading this notice or accepting the Terms as blanket consent to unrelated processing. You can use the non-AI features without sending a message to the AI assistant."
    ]
  },
  {
    "id": "required",
    "title": "Information required to participate",
    "paragraphs": [
      "An email address, username and password are required for an account; without them, authenticated features cannot be provided. Usernames and emails are normalized to lowercase in this version. AI prompts and friendship requests are optional. Avoid submitting sensitive personal information or information about other people that is not needed to use the service."
    ]
  },
  {
    "id": "visibility",
    "title": "Who can see information",
    "paragraphs": [
      "Signed-in users can search usernames and view public player profiles and ratings. Friends can see online presence. Game participants, results, statistics and tournament details can be visible through the relevant application screens and authorized public-API clients within the deployment. Invitation participants can see the relevant sender, recipient and response. Email addresses and password hashes are not included in public friends-profile responses. Authorized project administrators may access records needed to operate, troubleshoot or handle data requests."
    ]
  },
  {
    "id": "hosting",
    "title": "Local hosting and Gemini AI",
    "paragraphs": [
      "The application and its PostgreSQL database run on a local computer. Local hosting does not mean all processing stays on that computer: optional AI chat uses Google Gemini through the configured API. Chat messages, selected previous turns and supplied chess context such as FEN and moves can be sent to Google; moderation may also send message content to Gemini. AI conversations are not end-to-end encrypted against the provider. Do not send passwords, API keys, sensitive information or unnecessary identifying details."
    ]
  },
  {
    "id": "provider",
    "title": "Google’s separate processing",
    "paragraphs": [
      "Google’s handling of Gemini API requests depends on the specific service, account, regional terms and settings. It may include provider-side logging, abuse monitoring and processing outside the European Economic Area. Our local retention limits do not control those copies, and deleting your ChessHub account does not automatically delete provider records. We do not promise zero provider retention or that all Gemini services handle training identically. Contact Tomasz before using AI if you need details of the configured service, processing locations or applicable transfer safeguards. The applicable Google terms and privacy information must be checked for the deployed API; AI should remain disabled until those arrangements have been verified."
    ]
  },
  {
    "id": "cookies",
    "title": "Cookies and browser storage",
    "paragraphs": [
      "ChessHub uses the essential __Host-session cookie for authentication, marked Secure, HttpOnly and SameSite=Lax. Its validity is configurable from one minute to seven days, with a seven-day default. Logout invalidates that server session. Expired session records are cleaned up regularly; session validity and physical record removal are separate. The browser also uses sessionStorage to remember the last game ID for an account in that tab. Removing cookies signs you out; clearing browser storage can remove the reconnection reference. Connection addresses and errors may be processed by the application and reverse proxy for security and operation."
    ]
  },
  {
    "id": "retention",
    "title": "Retention policy",
    "paragraphs": [
      "Accounts, friendships, game history, tournament records and associated API-key records are retained during development and evaluation, then deleted within 30 days after the project’s final school evaluation. Earlier valid deletion requests are handled separately and do not have to wait for that date. Application and server logs are retained for no more than seven days; passwords, session tokens, API keys and AI conversation content must not be deliberately recorded in those logs. If local backups are made, they follow a rolling seven-day retention period and all remaining copies are removed during final project cleanup. These are operator-managed commitments, not a claim that the application implements automatic deletion jobs."
    ]
  },
  {
    "id": "ai-retention",
    "title": "Conversation retention",
    "paragraphs": [
      "The application policy is to keep AI conversation history only in browser memory for the current conversation and not deliberately store it in PostgreSQL or application logs. Ending or reloading that conversation can remove the local history, but does not retract messages already sent to Gemini. Provider-side retention is governed separately as described above. Human-to-human chat in this code version is a local demonstration rather than a persisted private messaging service."
    ]
  },
  {
    "id": "requests",
    "title": "Access, correction and deletion",
    "paragraphs": [
      "Email tszymans@student.42warsaw.pl to request access, correction, deletion or another applicable data-protection right, preferably from your registered address. Describe the request and your username; never send your password or session token. Tomasz verifies ownership using proportionate information, handles the request manually, and explains the outcome. Requests are handled without undue delay and normally answered within one month. If an extension is permitted for a complex request, the reason and revised timing will be communicated within the initial month."
    ]
  },
  {
    "id": "deletion",
    "title": "What deletion covers",
    "paragraphs": [
      "For an accepted deletion request, sessions and API keys are revoked and account information and associated personal records are removed. Game and tournament references are reviewed so identifiers or identifying text are not left behind inadvertently; records may be deleted where safe de-identification cannot be ensured. Backup copies expire within the rolling seven-day period and are not used for ordinary operations. If a backup is restored, previously completed deletions are reapplied before the restored service is used. Any specific lawful reason for retaining particular information will be explained rather than silently applied to the entire account."
    ]
  },
  {
    "id": "rights",
    "title": "Your rights",
    "paragraphs": [
      "Depending on the circumstances and applicable law, you may request access, correction, erasure, restriction or portability and object to processing based on legitimate interests. If any processing is based on consent, you may withdraw it without affecting earlier lawful processing. Rights have conditions and are not unlimited. You may lodge a complaint with a competent data protection authority, including the President of the Personal Data Protection Office (UODO) in Poland. Chess ratings, brackets and AI moderation involve automated processing; contact Tomasz to question an outcome or request a human review."
    ]
  },
  {
    "id": "security-changes",
    "title": "Security and updates",
    "paragraphs": [
      "HTTPS configuration, password hashing, session controls and access checks help protect the service; no system can guarantee absolute security. The operator controls the local machine, administrative access and backups. This notice will be reviewed before public deployment, new recipients, persisted private messaging or material changes to data use. Its version and effective date are displayed on this page."
    ]
  }
];
