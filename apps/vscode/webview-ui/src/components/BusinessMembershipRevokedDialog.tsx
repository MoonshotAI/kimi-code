import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useSettingsStore } from "@/stores";

interface BusinessMembershipRevokedDialogProps {
  onConfirm: () => void;
}

export function BusinessMembershipRevokedDialog({
  onConfirm,
}: BusinessMembershipRevokedDialogProps) {
  const {
    membershipRevokedOpen,
    membershipRevokedMessage,
    acknowledgeMembershipRevoked,
  } = useSettingsStore();

  const handleConfirm = () => {
    acknowledgeMembershipRevoked();
    onConfirm();
  };

  return (
    <AlertDialog open={membershipRevokedOpen}>
      <AlertDialogContent
        onEscapeKeyDown={(event) => {
          event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Removed from Business Workspace</AlertDialogTitle>
          <AlertDialogDescription>{membershipRevokedMessage}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={handleConfirm}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
