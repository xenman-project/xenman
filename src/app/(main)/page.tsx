"use client";

import { useXen } from "@/context/xen-context";
import { Dashboard } from "@/components/dashboard";
import { VmDetail } from "@/components/vm-detail";
import { HostDetail } from "@/components/host-detail";
import { XenHostDetail } from "@/components/xen-host-detail";

export default function Home() {
  const { state } = useXen();

  if (state.selectedVmRef) {
    return <VmDetail />;
  }

  if (state.selectedXenHostRef && state.selectedHostId) {
    return <XenHostDetail />;
  }

  if (state.selectedHostId) {
    return <HostDetail />;
  }

  return <Dashboard />;
}
