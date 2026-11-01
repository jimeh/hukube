import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
  SettingsPage,
  settingsCategories,
  type SettingsCategory,
} from "@/features/settings/settings-page.tsx";

const categorySchema = z.enum(settingsCategories);
const fromClusterSchema = z.string().min(1);

export function validateSettingsSearch(search: Record<string, unknown>): {
  category: SettingsCategory;
  fromCluster?: string;
} {
  const category = categorySchema.safeParse(search["category"]);
  const fromCluster = fromClusterSchema.safeParse(search["fromCluster"]);
  return {
    category: category.success ? category.data : "appearance",
    ...(fromCluster.success ? { fromCluster: fromCluster.data } : {}),
  };
}

export const Route = createFileRoute("/settings")({
  validateSearch: validateSettingsSearch,
  component: SettingsRoute,
});

function SettingsRoute() {
  const search = Route.useSearch();
  return <SettingsPage {...search} />;
}
