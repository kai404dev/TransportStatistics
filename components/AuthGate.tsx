"use client";

import { useUser, RedirectToSignIn } from "@clerk/nextjs";
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

type AuthGateProps = {
  children: ReactNode;
  fullScreen?: boolean;
};

function authSpinner(fullScreen: boolean) {
  return (
    <div
      className={`flex items-center justify-center ${
        fullScreen ? "h-screen" : "min-h-[60vh]"
      }`}
    >
      <LoaderCircle className="h-8 w-8 animate-spin text-ts-accent" />
    </div>
  );
}

export function AuthGate({ children, fullScreen = false }: AuthGateProps) {
  const { isLoaded, isSignedIn } = useUser();

  if (!isLoaded) {
    return authSpinner(fullScreen);
  }

  if (!isSignedIn) {
    return <RedirectToSignIn />;
  }

  return <>{children}</>;
}

export function useRequireAuth(fullScreen = false) {
  const { isLoaded, isSignedIn } = useUser();

  if (!isLoaded) {
    return authSpinner(fullScreen);
  }

  if (!isSignedIn) {
    return <RedirectToSignIn />;
  }

  return null;
}
