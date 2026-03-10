export function effectiveRecipient(params: { userAddress: string; recipient?: string }): string {
  return params.recipient ?? params.userAddress
}
