import { TopBar } from "@/components/shell/TopBar";
import { ChatPanel } from "@/components/shell/ChatPanel";
import { PreviewPanel } from "@/components/shell/PreviewPanel";

export default function Home() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <TopBar />
      <main className="flex min-h-0 flex-1">
        <ChatPanel />
        <PreviewPanel />
      </main>
    </div>
  );
}
