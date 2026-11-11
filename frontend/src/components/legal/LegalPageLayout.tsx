import { useEffect } from "react";
import { Link } from "react-router-dom";
import {
  siteDetails,
  type LegalSection,
} from "../../content/legal/site-details";
export function LegalPageLayout({
  title,
  sections,
}: {
  title: string;
  sections: LegalSection[];
}) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} | ChessHub`;
    window.scrollTo(0, 0);
    return () => {
      document.title = previous;
    };
  }, [title]);
  return (
    <main className="legal-page">
      <Link to="/">♞ ChessHub</Link>
      <article>
        <h1>{title}</h1>
        <p>
          {siteDetails.version} · Effective{" "}
          <time dateTime={siteDetails.effective}>{siteDetails.effective}</time>
        </p>
        <p>
          Operator: {siteDetails.operator}. Contact:{" "}
          {
            <a href={`mailto:${siteDetails.contactEmail}`}>
              {siteDetails.contactEmail}
            </a>
          }
          .
        </p>
        <nav aria-label={`${title} sections`}>
          <ol>
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>
        {sections.map((s) => (
          <section id={s.id} key={s.id}>
            <h2>{s.title}</h2>
            {s.paragraphs.map((text, i) => (
              <p key={i}>{text}</p>
            ))}
          </section>
        ))}
        <p>
          <Link to="/privacy-policy">Privacy Policy</Link> ·{" "}
          <Link to="/terms-of-service">Terms of Service</Link>
        </p>
      </article>
    </main>
  );
}
