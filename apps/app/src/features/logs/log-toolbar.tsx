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
import { useEffect, useRef } from "react";

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
  focus,
  select,
  setPrevious,
  search,
}: {
  containers: LogContainer[];
  container: string;
  previous: boolean;
  hasPrevious: boolean;
  disabled: boolean;
  /** The control that takes focus when the toolbar mounts, after the user's choice replaced it. */
  focus?: "container" | "previous";
  select: (value: string) => void;
  setPrevious: (value: boolean) => void;
  search: () => void;
}) {
  const { timestamps, wrap, setTimestamps, setWrap } = useLogSettings();
  const single = containers.length === 1;
  const containerTrigger = useRef<HTMLButtonElement>(null);
  const previousToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (focus === "container"
      ? containerTrigger
      : focus === "previous"
        ? previousToggle
        : null
    )?.current?.focus();
    // Only the mount that the choice caused takes focus.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggle = (
    label: string,
    icon: typeof Clock01Icon,
    pressed: boolean,
    change: (value: boolean) => void,
    unavailable = false,
    tooltip = label,
    ref?: React.Ref<HTMLButtonElement>,
  ) => (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Toggle
          ref={ref}
          aria-label={label}
          pressed={pressed}
          onPressedChange={change}
          disabled={disabled || unavailable}
          className="shrink-0 text-muted-foreground aria-pressed:bg-cluster-subtle aria-pressed:text-foreground @max-[34rem]/logs:w-7 @max-[34rem]/logs:p-0"
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
        {single ? (
          // One container is a fact, not a choice.
          <span className="min-w-0 truncate font-mono" title={containers[0]!.name}>
            {containers[0]!.name}
          </span>
        ) : (
          <Select
            value={container}
            onValueChange={(value) => {
              if (value !== null) select(value);
            }}
            disabled={disabled}
          >
            <SelectTrigger
              ref={containerTrigger}
              aria-label="Container"
              className="max-w-64 min-w-24 flex-1"
              size="sm"
            >
              <SelectValue className="truncate">
                {containers.length ? container || "All containers" : "Container"}
              </SelectValue>
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
        )}
        {toggle(
          "Previous run",
          TransactionHistoryIcon,
          previous,
          setPrevious,
          !previous && !hasPrevious,
          !previous && !hasPrevious ? "Previous run: no container has restarted" : "Previous run",
          previousToggle,
        )}
        <div className="min-w-1 flex-1" />
        {toggle("Timestamps", Clock01Icon, timestamps, setTimestamps)}
        {toggle("Wrap", TextWrapIcon, wrap, setWrap)}
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" />}
            aria-label="Search"
            disabled={disabled}
            onClick={search}
            className="text-muted-foreground @max-[34rem]/logs:w-7 @max-[34rem]/logs:p-0"
          >
            {iconLabel(Search01Icon, "Search")}
          </TooltipTrigger>
          <TooltipContent>Search</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
