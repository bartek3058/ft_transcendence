import type { ReactNode } from "react";
export function Page({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <h1>{title}</h1>
      <p>{sub}</p>
      {children}
    </div>
  );
}
