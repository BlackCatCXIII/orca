import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  back: { padding: spacing.xs },
  title: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '700' },
  content: { padding: spacing.lg, gap: spacing.lg },
  card: {
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  sectionTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  body: { color: colors.textSecondary, fontSize: typography.bodySize, lineHeight: 20 },
  meta: { color: colors.textMuted, fontSize: typography.metaSize },
  error: { color: colors.statusRed, fontSize: typography.bodySize },
  row: { gap: spacing.sm, paddingVertical: spacing.xs },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  button: {
    minHeight: 36,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  primaryButton: { backgroundColor: colors.surfaceBright },
  buttonText: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  primaryButtonText: { color: colors.bgBase },
  destructiveText: { color: colors.statusRed },
  disabled: { opacity: 0.45 }
})
