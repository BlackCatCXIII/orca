import { Cloud } from 'lucide-react-native'
import { Pressable, StyleSheet } from 'react-native'
import { colors } from '../theme/mobile-theme'

export function EnvironmentWorkspacesHeaderButton({
  disabled,
  onPress
}: {
  disabled: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      style={styles.button}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Environment workspaces"
    >
      <Cloud size={18} color={disabled ? colors.textMuted : colors.textSecondary} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }
})
