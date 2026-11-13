import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'discovery_models.dart';
import 'format.dart';

const salonTypeLabels = {'MEN': 'Men', 'LADIES': 'Ladies', 'UNISEX': 'Unisex'};

/// One search result. Everything shown comes from the API; a missing value is hidden, never invented.
class SalonCardTile extends StatelessWidget {
  const SalonCardTile({super.key, required this.salon, required this.onTap});

  final SalonCard salon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final next = salon.nextAvailable;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.sm),
      child: Card(
        clipBehavior: Clip.antiAlias,
        margin: EdgeInsets.zero,
        child: InkWell(
          onTap: onTap,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            AspectRatio(
              aspectRatio: 16 / 9,
              child: salon.coverUrl == null
                  ? const _CoverPlaceholder()
                  : Image.network(
                      salon.coverUrl!,
                      fit: BoxFit.cover,
                      semanticLabel: 'Photo of ${salon.name}',
                      errorBuilder: (_, __, ___) => const _CoverPlaceholder(),
                      loadingBuilder: (context, child, progress) => progress == null ? child : const _CoverPlaceholder(),
                    ),
            ),
            Padding(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text(salon.name, style: theme.textTheme.titleMedium, maxLines: 1, overflow: TextOverflow.ellipsis)),
                  const SizedBox(width: AppSpacing.sm),
                  Text(salon.rating == null ? 'New' : '${salon.rating!.toStringAsFixed(1)} (${salon.ratingCount})',
                      style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
                ]),
                const SizedBox(height: AppSpacing.xs),
                Text('${salon.area}, ${salon.city}', style: theme.textTheme.bodyMedium?.copyWith(color: AppColors.mutedText), maxLines: 1, overflow: TextOverflow.ellipsis),
                const SizedBox(height: AppSpacing.md),
                Wrap(spacing: AppSpacing.sm, runSpacing: AppSpacing.xs, children: [
                  _Pill(salonTypeLabels[salon.salonType] ?? salon.salonType),
                  if (salon.distanceKm != null) _Pill('${salon.distanceKm!.toStringAsFixed(1)} km away'),
                  _Pill('${salon.serviceCount} ${salon.serviceCount == 1 ? 'service' : 'services'}'),
                ]),
                const SizedBox(height: AppSpacing.md),
                Row(children: [
                  Expanded(child: Text('From ${formatPkr(salon.priceFrom)}', style: theme.textTheme.titleSmall)),
                  if (next != null)
                    Flexible(
                      child: Text('Next: ${describeNextSlot(next.date, next.time)}',
                          style: theme.textTheme.bodySmall?.copyWith(color: AppColors.emerald), textAlign: TextAlign.end, overflow: TextOverflow.ellipsis),
                    ),
                ]),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xs),
        decoration: BoxDecoration(color: Theme.of(context).colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(AppRadius.full)),
        child: Text(text, style: Theme.of(context).textTheme.labelMedium),
      );
}

class _CoverPlaceholder extends StatelessWidget {
  const _CoverPlaceholder();

  @override
  Widget build(BuildContext context) => Container(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        alignment: Alignment.center,
        child: const Icon(Icons.content_cut, size: 40, color: AppColors.mutedText),
      );
}
