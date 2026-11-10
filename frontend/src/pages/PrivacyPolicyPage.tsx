import { LegalPageLayout } from "../components/legal/LegalPageLayout";
import { privacySections } from "../content/legal/privacy";
export function PrivacyPolicyPage() { return <LegalPageLayout title="Privacy Policy" sections={privacySections} />; }
