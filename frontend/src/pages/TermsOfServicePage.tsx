import { LegalPageLayout } from "../components/legal/LegalPageLayout";
import { termsSections } from "../content/legal/terms";
export function TermsOfServicePage() { return <LegalPageLayout title="Terms of Service" sections={termsSections} />; }
