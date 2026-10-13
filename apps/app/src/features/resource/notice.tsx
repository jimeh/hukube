import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@hukube/ui/components/empty";

import type { ReactNode } from "react";

/** The shared empty-state notice for Resource Facets. */
export function Notice({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription className="whitespace-pre-line">{description}</EmptyDescription>
      </EmptyHeader>
      {action}
    </Empty>
  );
}
