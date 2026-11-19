import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'offline_models.dart';

/// The five states of requirement 15 in one small chip: Online, Offline, Syncing, Sync failed, Synced.
class SyncStatusChip extends StatelessWidget {
  const SyncStatusChip({super.key, required this.status, this.onTap});
  final SyncStatus status;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final (label, color, icon) = switch (status.phase) {
      SyncPhase.online => ('Online', AppColors.emerald, Icons.cloud_done_outlined),
      SyncPhase.offline => ('Offline', AppColors.warning, Icons.cloud_off_outlined),
      SyncPhase.syncing => ('Syncing…', AppColors.info, Icons.sync),
      SyncPhase.failed => ('Sync failed', AppColors.danger, Icons.error_outline),
      SyncPhase.synced => ('Synced', AppColors.emerald, Icons.cloud_done_outlined),
    };
    final waiting = status.waiting > 0 ? ' · ${status.waiting} waiting' : '';
    return Semantics(
      button: onTap != null,
      label: 'Sync status: $label$waiting',
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.full),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 18, color: color),
              const SizedBox(width: AppSpacing.xs),
              Flexible(child: Text('$label$waiting', style: TextStyle(color: color, fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
            ]),
          ),
        ),
      ),
    );
  }
}
