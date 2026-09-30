import { createFileRoute } from "@tanstack/react-router";

import { ClusterPicker } from "@/features/clusters/cluster-picker.tsx";

export const Route = createFileRoute("/")({ component: ClusterPicker });
