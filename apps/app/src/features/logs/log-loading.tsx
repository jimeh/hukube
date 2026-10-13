import { LogToolbar } from "./log-toolbar.tsx";
import { Skeleton } from "@hukube/ui/components/skeleton";

export function LogLoading({ toolbar = false }: { toolbar?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading Log Stream" className="h-full">
      {toolbar && (
        <LogToolbar
          containers={[]}
          container=""
          previous={false}
          hasPrevious={false}
          disabled
          select={() => {}}
          setPrevious={() => {}}
          search={() => {}}
        />
      )}
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-64 max-w-full" />
        <Skeleton className="h-3 w-52" />
      </div>
    </div>
  );
}
