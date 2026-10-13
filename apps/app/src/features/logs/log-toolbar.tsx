import type { LogContainer } from "@hukube/engine-client";
import { Button } from "@hukube/ui/components/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@hukube/ui/components/select";
import { Toggle } from "@hukube/ui/components/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import {
  Clock01Icon,
  Search01Icon,
  TextWrapIcon,
  TransactionHistoryIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLogSettings } from "./log-settings.ts";

const groups = [
  ["container", "Containers"],
  ["init", "Init containers"],
  ["ephemeral", "Ephemeral containers"],
] as const;
const iconLabel = (icon: typeof Clock01Icon, label: string) => (
  <>
    <HugeiconsIcon icon={icon} data-icon="inline-start" aria-hidden="true" />
    <span className="hidden @min-[34rem]/logs:inline">{label}</span>
  </>
);

export function LogToolbar({
  containers,
  container,
  previous,
  hasPrevious,
  disabled,
  select,
  setPrevious,
  search,
}: {
  containers: LogContainer[];
  container: string;
  previous: boolean;
  hasPrevious: boolean;
  disabled: boolean;
  select: (value: string) => void;
  setPrevious: (value: boolean) => void;
  search: () => void;
}) {
  const { timestamps, wrap, setTimestamps, setWrap } = useLogSettings();
  const single = containers.length === 1;
  const displayed = single ? containers[0]!.name : container;
  const toggle = (
    label: string,
    icon: typeof Clock01Icon,
    pressed: boolean,
    change: (value: boolean) => void,
    unavailable = false,
    tooltip = label,
  ) => (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Toggle
          aria-label={label}
          pressed={pressed}
          onPressedChange={change}
          disabled={disabled || unavailable}
          className="shrink-0 @max-[34rem]/logs:w-7 @max-[34rem]/logs:p-0"
        >
          {iconLabel(icon, label)}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
  return (
    <div className="@container/logs shrink-0 border-b">
      <div role="toolbar" aria-label="Log Stream" className="flex h-8 items-center gap-1 px-3">
        <Select
          value={displayed}
          onValueChange={(value) => {
            if (value !== null) select(value);
          }}
          disabled={disabled || single}
        >
          <SelectTrigger aria-label="Container" className="min-w-24 flex-1" size="sm">
            <SelectValue className="truncate">{displayed || "All containers"}</SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              <SelectItem value="">All containers</SelectItem>
            </SelectGroup>
            {groups.map(([kind, label]) => {
              const options = containers.filter((item) => item.kind === kind);
              return (
                options.length > 0 && (
                  <SelectGroup key={kind}>
                    <SelectLabel>{label}</SelectLabel>
                    {options.map((item) => (
                      <SelectItem key={item.name} value={item.name}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )
              );
            })}
          </SelectContent>
        </Select>
        {toggle(
          "Previous run",
          TransactionHistoryIcon,
          previous,
          setPrevious,
          !previous && !hasPrevious,
          !previous && !hasPrevious ? "No container has restarted" : "Previous run",
        )}
        <div className="w-1 shrink-0" />
        {toggle("Timestamps", Clock01Icon, timestamps, setTimestamps)}
        {toggle("Wrap", TextWrapIcon, wrap, setWrap)}
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" />}
            aria-label="Search"
            disabled={disabled}
            onClick={search}
            className="@max-[34rem]/logs:w-7 @max-[34rem]/logs:p-0"
          >
            {iconLabel(Search01Icon, "Search")}
          </TooltipTrigger>
          <TooltipContent>Search</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
