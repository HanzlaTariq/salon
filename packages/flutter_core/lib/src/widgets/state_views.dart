import 'package:flutter/material.dart';

import '../theme/tokens.dart';

/// Reusable loading / empty / error states (every screen must use these).
class LoadingView extends StatelessWidget {
  const LoadingView({super.key, this.label});
  final String? label;

  @override
  Widget build(BuildContext context) => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const CircularProgressIndicator(strokeWidth: 2.5),
          if (label != null) ...[
            const SizedBox(height: AppSpacing.lg),
            Text(label!, style: Theme.of(context).textTheme.bodyMedium),
          ],
        ]),
      );
}

class EmptyView extends StatelessWidget {
  const EmptyView({super.key, required this.title, this.message, this.icon = Icons.inbox_outlined, this.action});
  final String title;
  final String? message;
  final IconData icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) => _Centered(icon: icon, title: title, message: message, action: action);
}

class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.message, this.onRetry, this.requestId});
  final String message;
  final VoidCallback? onRetry;

  /// Shown so users can quote it to support (matches the API error `requestId`).
  final String? requestId;

  @override
  Widget build(BuildContext context) => _Centered(
        icon: Icons.error_outline,
        iconColor: AppColors.danger,
        title: 'Something went wrong',
        message: requestId == null ? message : '$message\nReference: $requestId',
        action: onRetry == null ? null : OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
      );
}

class _Centered extends StatelessWidget {
  const _Centered({required this.icon, required this.title, this.message, this.action, this.iconColor});
  final IconData icon;
  final Color? iconColor;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 48, color: iconColor ?? AppColors.mutedText),
            const SizedBox(height: AppSpacing.lg),
            Text(title, style: theme.textTheme.titleMedium, textAlign: TextAlign.center),
            if (message != null) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(message!,
                  style: theme.textTheme.bodyMedium?.copyWith(color: AppColors.mutedText),
                  textAlign: TextAlign.center),
            ],
            if (action != null) ...[const SizedBox(height: AppSpacing.xl), action!],
          ]),
        ),
      ),
    );
  }
}
